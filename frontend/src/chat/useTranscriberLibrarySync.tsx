import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createTranscriberClient, type TranscriberClient, type TranscriberListRow, type TranscriberMeeting, type TranscriberTranscript } from "@/lib/transcriberApi";
import { listSavedTranscriberMeetingIds, listSavedTranscriberVersions, refreshTranscriberMeeting, saveTranscriberMeeting, TRANSCRIBER_MEETING_SOURCE } from "@/lib/transcriberSave";
import { isSecretsUnlocked, onSecretsUnlocked } from "@/lib/connectors/connectorSecrets";
import { secretsAvailable } from "@/lib/openkeyNative";
import { captureEvents } from "@/capture/captureEvents";
import { enqueueDrainWork } from "./useBackgroundDrain";
import { serverDeliveryActive } from "@/lib/transcriptDeliveryState";
import { transcriberPendingRows, writePendingReconcileSnapshot } from "@/lib/connectors/pendingReconcileSnapshot";

export type TranscriberSaveState = "saving" | "saved" | "error";
/** Cadence while a pass left work to retry (a failed recording, a failed read, a row still being delivered). */
export const TRANSCRIBER_LIBRARY_RETRY_MS = 30_000;
/**
 * Cadence of an idle visible tab: the previous pass settled, so a tick only looks for meetings that
 * finished elsewhere. Each pass is one SQL read and one KV read on the node, per account.
 */
export const TRANSCRIBER_LIBRARY_IDLE_MS = 120_000;
const SERVER_DELIVERY_GRACE_MS = 10 * 60_000;
/** Web Lock and BroadcastChannel name prefix; the account DID completes it. */
const SYNC_SCOPE = "tinychat:transcriber-library-sync";
/** Confirmed ids per cross-tab message during a scan: frequent enough to survive a tab closing mid-scan. */
const CONFIRM_BATCH = 50;
/**
 * Longest a pass may hold the account-wide sync lock (TC-1274). Each transcriber API call
 * is bounded at 20 s; a pass still running at 60 s is stuck behind this tab's space lane
 * or has more to save than one pass should hold the lock for. The next pass continues:
 * saves skip rows already in the space.
 */
export const TRANSCRIBER_PASS_DEADLINE_MS = 60_000;
let passDeadlineMs: number | null = null;
/** Tests only: shorten the pass deadline; null restores it. */
export function setTranscriberPassDeadlineForTests(ms: number | null): void { passDeadlineMs = ms; }
type SyncMessage =
  | { kind: "pass"; at: number; retry?: boolean }
  | { kind: "state"; id: string; state: TranscriberSaveState }
  | { kind: "confirmed"; ids: string[] }
  | { kind: "unconfirmed"; ids: string[] }
  | { kind: "library-changed"; sourceId: string };
const SavedContext = createContext<Readonly<Record<string, TranscriberSaveState>>>({});
export const useTranscriberSavedState = () => useContext(SavedContext);

export interface TranscriberLibrarySaver {
  listSaved(
    tcw: TinyCloudWeb,
    scheduleRead?: <T>(read: () => Promise<T>) => Promise<T | null>,
    isCurrent?: () => boolean,
    confirmed?: ReadonlySet<string>,
    onConfirmed?: (id: string) => void,
): Promise<{ ok: boolean; data?: { saved: string[]; unknown: string[]; scanned?: boolean } }>;
  listVersions?: typeof listSavedTranscriberVersions;
  refresh?: typeof refreshTranscriberMeeting;
  save(tcw: TinyCloudWeb, meeting: TranscriberMeeting, transcript: TranscriberTranscript): Promise<{ ok: boolean }>;
}
const defaultSaver: TranscriberLibrarySaver = {
  listSaved: listSavedTranscriberMeetingIds, listVersions: listSavedTranscriberVersions,
  save: saveTranscriberMeeting, refresh: refreshTranscriberMeeting,
};

/** Each completeness read takes its own turn on the drain lane, and is dropped once the pass is stale. */
const readOnDrainLane = (isCurrent: () => boolean, onProgress: () => void = () => {}) =>
  <T,>(read: () => Promise<T>): Promise<T | null> =>
    enqueueDrainWork(() => isCurrent() ? read() : Promise.resolve(null)).finally(onProgress);

export type TranscriberRefreshBackoff = Map<string, { failures: number; retryAt: number }>;

/** One sequential pass. SQL source IDs alone never mark an import complete. */
export async function syncTranscriberLibrary(input: {
  tcw: TinyCloudWeb;
  client: TranscriberClient;
  saver?: TranscriberLibrarySaver;
  isCurrent?: () => boolean;
  /** Per mounted provider: first saved-id read is the baseline, later unseen ids are new. */
  observedSaved?: { initialized: boolean; ids: Set<string> };
  onState?: (id: string, state: TranscriberSaveState) => void;
  deliveryActive?: () => boolean;
  now?: () => number;
refreshBackoff?: TranscriberRefreshBackoff;
  /**
   * Per mounted provider: stored publication numbers already read. They only grow, so a
   * listed version at or below one needs no SQL read; only newer listings are looked up.
   */
  knownVersions?: Map<string, number>;
  /**
   * Per account: saved ids whose transcript body this session already confirmed (TC-1274).
   * Only ids outside it get a KV check, so a steady-state pass costs O(new), not O(saved).
   */
  confirmedSaved?: Set<string>;
  /** Ids newly added to `confirmedSaved`, for other tabs; sent in batches while the scan runs. */
  onConfirmed?: (ids: string[]) => void;
  /** Ids dropped from `confirmedSaved` because their row is gone, for other tabs. */
  onUnconfirmed?: (ids: string[]) => void;
  /** Each completed step (API call, space read or write): the pass is making progress. */
  onProgress?: () => void;
  /** Called when the pass could not finish its reads, or left a row it should retry. */
  onRetryNeeded?: () => void;
onPendingSnapshot?: (
    rows: readonly TranscriberListRow[],
    savedIds: readonly string[],
    unknownIds: readonly string[],
    observedAt: string,
  ) => Promise<void>;
  observedAt?: () => string;
}): Promise<void> {
  const { tcw, client, saver = defaultSaver, isCurrent = () => true, onState: emitState = () => {}, observedSaved,
    deliveryActive = serverDeliveryActive, now = Date.now, refreshBackoff = new Map(), knownVersions = new Map(),
    confirmedSaved = new Set<string>(), onConfirmed = () => {}, onUnconfirmed = () => {}, onProgress = () => {},
    onRetryNeeded = () => {} } = input;
  // Rows whose last state is not "saved" (failed, or still being delivered) need the faster retry cadence.
  const unsettled = new Set<string>();
  const onState = (id: string, state: TranscriberSaveState) => {
    if (state === "saved") unsettled.delete(id); else unsettled.add(id);
    emitState(id, state);
  };
  const step = <T,>(work: Promise<T>): Promise<T> => work.finally(onProgress);
  // Confirmations go out in batches as the scan runs, so a tab that takes over after this
  // one closes mid-scan starts from the ids already confirmed instead of from zero.
  const unsent: string[] = [];
  const flushConfirmed = () => { if (unsent.length > 0) onConfirmed(unsent.splice(0)); };
  const confirm = (id: string) => {
    if (confirmedSaved.has(id)) return;
    confirmedSaved.add(id);
    unsent.push(id);
    if (unsent.length >= CONFIRM_BATCH) flushConfirmed();
  };
  const failedRefresh = (id: string) => {
    const failures = (refreshBackoff.get(id)?.failures ?? 0) + 1;
    refreshBackoff.set(id, { failures, retryAt: now() + Math.min(30 * 60_000, 60_000 * 2 ** (failures - 1)) });
  };
  if (!isCurrent()) return;
  // This API call can be slow or retry for tens of seconds; it does not touch
  // the user's space and must never occupy the serial space-write lane.
  const observedAt = input.observedAt?.() ?? new Date().toISOString();
  const listed = await step(client.list());
  if (listed.status !== "ok" || !isCurrent()) { if (isCurrent()) onRetryNeeded(); return; }
  // Each SQL/KV completeness read takes its own turn. A library with many
  // saved recordings therefore yields the lane between keys for voice notes.
  const complete = await saver.listSaved(tcw, readOnDrainLane(isCurrent, onProgress), isCurrent, confirmedSaved, confirm);
  // A pass that stalled and lost the lock must not announce late: another tab may have
  // pruned one of these ids since, and a late `confirmed` would undo that prune.
  if (!complete?.ok || !isCurrent()) { if (isCurrent()) onRetryNeeded(); return; }
  flushConfirmed();
  const saved = new Set(complete.data?.saved ?? []);
  for (const id of saved) confirm(id);
  flushConfirmed();
  // Only a scan that reached every row can say a confirmed id has no row any more
  // (deleted or purged): forget it, so a row written again under it gets its body checked.
  if (complete.data?.scanned) {
    const listedIds = new Set([...saved, ...(complete.data.unknown ?? [])]);
    const gone = [...confirmedSaved].filter((id) => !listedIds.has(id));
    for (const id of gone) confirmedSaved.delete(id);
    if (gone.length > 0) onUnconfirmed(gone);
  }
  const newer = listed.value.meetings.filter((row) => !("unavailable" in row) && row.status === "completed"
    && saved.has(row.id) && Number.isInteger(row.transcript?.version)
    && row.transcript!.version! > (knownVersions.get(row.id) ?? 1)).map((row) => row.id);
  const versions = !saver.listVersions ? { ok: false as const }
    : newer.length === 0 ? { ok: true as const }
      : await saver.listVersions(tcw, newer, readOnDrainLane(isCurrent, onProgress));
  if (!isCurrent()) return;
  if (newer.length > 0 && !versions.ok) onRetryNeeded();
  if (versions.ok && "data" in versions) for (const [id, version] of versions.data) knownVersions.set(id, version);
  let refreshes = 0;
  if (observedSaved && !observedSaved.initialized) {
    for (const id of saved) observedSaved.ids.add(id);
    observedSaved.initialized = true;
  }
  for (const row of listed.value.meetings) {
    if (!isCurrent()) return;
    if ("unavailable" in row || row.status !== "completed") continue;
    if (saved.has(row.id)) {
      const version = row.transcript?.version;
      const completedAt = Date.parse(row.completed_at ?? row.ended_at ?? "");
      const inGrace = row.metadata?.shared !== true && Number.isFinite(completedAt)
        && now() - completedAt < SERVER_DELIVERY_GRACE_MS;
      // A newer publication this pass could not refresh yet (cap, or still inside delivery grace) is due again soon.
      if (versions.ok && Number.isInteger(version) && version! > (knownVersions.get(row.id) ?? 1)
        && (refreshes >= 3 || inGrace)) onRetryNeeded();
      if (versions.ok && Number.isInteger(version) && version! > (knownVersions.get(row.id) ?? 1)
        && refreshes < 3 && !inGrace && (refreshBackoff.get(row.id)?.retryAt ?? 0) <= now()) {
        refreshes++;
        onState(row.id, "saving");
        try {
          const fetched = await step(client.transcript(row.id));
          if (!isCurrent()) return;
          if (fetched.status === "ok" && fetched.value.status === "ready"
            && fetched.value.transcript.version === version) {
            const fetchedTranscript = fetched.value.transcript;
            const result = await step(enqueueDrainWork(() => isCurrent()
              ? (saver.refresh ?? refreshTranscriberMeeting)(tcw, row, fetchedTranscript, async () => {
                const latest = await step(client.transcript(row.id));
                return isCurrent() && latest.status === "ok" && latest.value.status === "ready"
                  ? latest.value.transcript : null;
              })
              : Promise.resolve(null)));
            if (!isCurrent()) return;
            onState(row.id, result?.ok ? "saved" : "error");
            if (result?.ok) {
              refreshBackoff.delete(row.id);
              knownVersions.delete(row.id);
              observedSaved?.ids.add(row.id);
            } else failedRefresh(row.id);
            continue;
          }
          failedRefresh(row.id);
          onState(row.id, "error");
          continue;
        } catch {
          failedRefresh(row.id);
          if (isCurrent()) onState(row.id, "error");
          continue;
        }
      }
      if (observedSaved && !observedSaved.ids.has(row.id)) {
        captureEvents.emit("library-changed", { source: TRANSCRIBER_MEETING_SOURCE, sourceId: row.id });
        observedSaved.ids.add(row.id);
      }
      onState(row.id, "saved");
      continue;
    }
    const completedAt = Date.parse(row.completed_at ?? row.ended_at ?? "");
    // A meeting shared into this list (TC-581) is the owner's; the server never delivers it here.
    const shared = row.metadata?.shared === true;
    if (!shared && deliveryActive() && Number.isFinite(completedAt) && now() - completedAt < SERVER_DELIVERY_GRACE_MS) {
      onState(row.id, "saving");
      continue;
    }
    onState(row.id, "saving");
    try {
      const result = await step(client.transcript(row.id));
      if (!isCurrent()) return;
      let ok = false;
      if (result.status === "ok" && result.value.status === "ready") {
        const fetchedTranscript = result.value.transcript;
        const saved = await step(enqueueDrainWork(async () => {
          if (!isCurrent()) return null;
          return saver.save(tcw, row, fetchedTranscript);
        }));
        ok = saved?.ok === true;
      }
      if (!isCurrent()) return;
      if (ok) {
        saved.add(row.id);
        confirm(row.id);
        flushConfirmed();
        observedSaved?.ids.add(row.id);
        captureEvents.emit("library-changed", { source: TRANSCRIBER_MEETING_SOURCE, sourceId: row.id });
      }
      onState(row.id, ok ? "saved" : "error");
    } catch {
      // One broken recording must not starve the rest or leak error payloads.
      if (isCurrent()) onState(row.id, "error");
    }
  }
  if (unsettled.size > 0) onRetryNeeded();
  if (isCurrent()) await input.onPendingSnapshot?.(listed.value.meetings, [...saved], complete.data?.unknown ?? [], observedAt);
}

export function useTranscriberLibrarySync(input: {
  tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore; enabled?: boolean;
  client?: TranscriberClient; saver?: TranscriberLibrarySaver;
}): Readonly<Record<string, TranscriberSaveState>> {
  const { tcw, backendUrl, sessionStore, enabled = true, client, saver = defaultSaver } = input;
  const api = useMemo(() => client ?? createTranscriberClient(backendUrl, { sessionStore }), [backendUrl, sessionStore, client]);
  const [saved, setSaved] = useState<Record<string, TranscriberSaveState>>({});
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let lockWarned = false;
    // Newest finished pass by any of this account's tabs (TC-1274).
    let lastPassAt = 0;
    // Newest finished pass left work to retry (failed read or recording): keep the faster cadence.
    let retryNeeded = false;
    let passRetry = false;
    let relaying = false;
    const refreshBackoff: TranscriberRefreshBackoff = new Map();
    const knownVersions = new Map<string, number>();
    // Saved ids whose transcript body this account's tabs confirmed this session (TC-1274).
    const confirmedSaved = new Set<string>();
    const observedSaved = { initialized: false, ids: new Set<string>() };
    setSaved({});
    // This sync writes the user's space but never touches the vault; native
    // OpenKey sessions have no secrets space and can still sync meetings.
    const unlocked = () => !secretsAvailable() || isSecretsUnlocked(tcw);
    const accountDid = tcw.did;
    const accountAddress = sessionStore.getAddress();
    const accountCurrent = () => enabled && !cancelled && tcw.did === accountDid
      && sessionStore.getAddress() === accountAddress && !!sessionStore.getToken();
    const sessionCurrent = () => accountCurrent() && !sessionStore.isExpired();
    const setState = (id: string, state: TranscriberSaveState) => {
      if (accountCurrent()) setSaved((old) => ({ ...old, [id]: state }));
    };
    // Every open tab used to run its own pass every interval, each one a queued read
    // on the space's connectors database. Tabs now share one cadence: a Web Lock
    // admits one pass at a time, and each pass's finish time, row states and Library
    // changes reach the other tabs, so N tabs make about one pass per interval.
    const scope = `${SYNC_SCOPE}:${accountDid}`;
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(scope);
    const post = (message: SyncMessage) => {
      try { channel?.postMessage(message); } catch { /* A closing tab has nothing to share. */ }
    };
    if (channel) channel.onmessage = (event: MessageEvent<SyncMessage>) => {
      const message = event.data;
      if (!accountCurrent()) return;
      if (message.kind === "pass" && message.at >= lastPassAt) { lastPassAt = message.at; retryNeeded = message.retry === true; }
      else if (message.kind === "state") setState(message.id, message.state);
      else if (message.kind === "confirmed") for (const id of message.ids) confirmedSaved.add(id);
      else if (message.kind === "unconfirmed") for (const id of message.ids) confirmedSaved.delete(id);
      else if (message.kind === "library-changed") {
        relaying = true;
        try { captureEvents.emit("library-changed", { source: TRANSCRIBER_MEETING_SOURCE, sourceId: message.sourceId }); }
        finally { relaying = false; }
      }
    };
    const unsubscribeChanges = captureEvents.on("library-changed", (detail) => {
      if (!relaying && detail?.source === TRANSCRIBER_MEETING_SOURCE) post({ kind: "library-changed", sourceId: detail.sourceId });
    });
    const confirmed = (ids: string[]) => { if (accountCurrent()) post({ kind: "confirmed", ids }); };
    const unconfirmed = (ids: string[]) => { if (accountCurrent()) post({ kind: "unconfirmed", ids }); };
    const pass = async (current: () => boolean, progress: () => void) => {
      // Meeting storage is readable with the vault locked. Snapshot now so
      // another device's saves during the lock are not part of the baseline.
      if (!observedSaved.initialized && !unlocked()) {
        const baseline = await saver.listSaved(tcw, readOnDrainLane(current, progress), current, confirmedSaved);
        if (baseline?.ok && current()) {
          for (const id of baseline.data?.saved ?? []) observedSaved.ids.add(id);
          observedSaved.initialized = true;
        }
      }
      if (sessionCurrent() && unlocked()) {
        // Each save takes the drain lane itself; the pass as a whole does not hold it.
        await syncTranscriberLibrary({
          tcw, client: api, saver, isCurrent: current, observedSaved, refreshBackoff, knownVersions,
          confirmedSaved, onConfirmed: confirmed, onUnconfirmed: unconfirmed, onProgress: progress,
          onRetryNeeded: () => { if (current()) passRetry = true; }, onState: (id, state) => {
            setState(id, state);
            if (accountCurrent()) post({ kind: "state", id, state });
          },
          onPendingSnapshot: async (rows, savedIds, unknownIds, observedAt) => {
            if (!current()) return;
            await enqueueDrainWork(() => current()
              ? writePendingReconcileSnapshot(tcw.kv, "transcriber", transcriberPendingRows(rows, savedIds, unknownIds), observedAt, current)
              : Promise.resolve({ ok: true, changed: false })).finally(progress);
          },
        });
      }
    };
    // The pass holds the account-wide lock, and its space calls have no deadline of their
    // own: a hung drain lane in this tab must not stop sync in every tab. The deadline is
    // an idle one: every completed step restarts it, so a long scan that keeps moving runs
    // to the end, and only a pass with no step finished for the whole deadline counts as
    // stuck. Then the pass is abandoned (its remaining steps see `current()` false and
    // stop) and the lock is let go; the next tick, here or in another tab, starts afresh.
    // setTimeout, not AbortSignal.timeout: Safari before 16 lacks it.
    const boundedPass = async () => {
      const idleMs = passDeadlineMs ?? TRANSCRIBER_PASS_DEADLINE_MS;
      const stalled = new AbortController();
      let timer = setTimeout(() => stalled.abort(), idleMs);
      const progress = () => {
        if (stalled.signal.aborted) return;
        clearTimeout(timer);
        timer = setTimeout(() => stalled.abort(), idleMs);
      };
      const current = () => accountCurrent() && !stalled.signal.aborted;
      passRetry = false;
      const expired = new Promise<void>((resolve) => stalled.signal.addEventListener("abort", () => resolve(), { once: true }));
      try {
        await Promise.race([pass(current, progress).catch(() => { passRetry = true; /* The next wake retries failures outside an individual recording. */ }), expired]);
      } finally { clearTimeout(timer); }
      // A failed pass counts too; a stalled one does not hold other tabs back.
      if (stalled.signal.aborted) return;
      lastPassAt = Date.now();
      retryNeeded = passRetry;
      post({ kind: "pass", at: lastPassAt, retry: passRetry });
    };
    const start = (scheduled: boolean) => {
      if (!sessionCurrent() || running || (!unlocked() && observedSaved.initialized)) return;
      // Offline there is nothing to read or save; the online event starts the next pass.
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      // A pass another tab (or this one) finished recently already covered this tick: a settled
      // account is looked at every TRANSCRIBER_LIBRARY_IDLE_MS, one with work left to retry sooner.
      if (scheduled && Date.now() - lastPassAt
        < (retryNeeded ? TRANSCRIBER_LIBRARY_RETRY_MS : TRANSCRIBER_LIBRARY_IDLE_MS) - TRANSCRIBER_LIBRARY_RETRY_MS / 2) return;
      running = true;
      const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
      const exclusive = locks?.request
        ? locks.request(scope, { mode: "exclusive", ifAvailable: true }, async (lock) => { if (lock) await boundedPass(); })
          .catch((error: unknown) => {
            // The lock only saves load; a tab that cannot take it syncs on its own.
            if (!lockWarned) console.warn("[transcriber-sync] Web Lock unavailable; this tab syncs on its own", error);
            lockWarned = true;
            return boundedPass();
          })
        : boundedPass();
      void exclusive.finally(() => { running = false; });
    };
    const run = () => start(false);
    // A hidden tab makes no scheduled reads; focus, visibilitychange and online start a pass on return.
    const tick = () => { if (document.visibilityState !== "hidden") start(true); };
    run();
    const unsubscribe = onSecretsUnlocked(run);
    const timer = window.setInterval(tick, TRANSCRIBER_LIBRARY_RETRY_MS);
    const onReturn = () => { if (document.visibilityState === "visible") run(); };
    window.addEventListener("focus", run);
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeChanges();
      channel?.close();
      window.clearInterval(timer);
      window.removeEventListener("focus", run);
      window.removeEventListener("online", run);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [api, tcw, sessionStore, enabled, saver]);
  return saved;
}

/** Mounted once in the authenticated app shell; Sources only consumes its progress. */
export function TranscriberLibrarySyncProvider(props: {
  tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore; enabled?: boolean; children: ReactNode;
}) {
  const saved = useTranscriberLibrarySync(props);
  return <SavedContext.Provider value={saved}>{props.children}</SavedContext.Provider>;
}
