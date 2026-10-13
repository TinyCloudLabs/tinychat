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
export const TRANSCRIBER_LIBRARY_RETRY_MS = 30_000;
const SERVER_DELIVERY_GRACE_MS = 10 * 60_000;
const SavedContext = createContext<Readonly<Record<string, TranscriberSaveState>>>({});
export const useTranscriberSavedState = () => useContext(SavedContext);

export interface TranscriberLibrarySaver {
  listSaved(
    tcw: TinyCloudWeb,
    scheduleRead?: <T>(read: () => Promise<T>) => Promise<T | null>,
    isCurrent?: () => boolean,
  ): Promise<{ ok: boolean; data?: string[] }>;
  listVersions?: typeof listSavedTranscriberVersions;
  refresh?: typeof refreshTranscriberMeeting;
  save(tcw: TinyCloudWeb, meeting: TranscriberMeeting, transcript: TranscriberTranscript): Promise<{ ok: boolean }>;
}
const defaultSaver: TranscriberLibrarySaver = {
  listSaved: listSavedTranscriberMeetingIds, listVersions: listSavedTranscriberVersions,
  save: saveTranscriberMeeting, refresh: refreshTranscriberMeeting,
};

/** Each completeness read takes its own turn on the drain lane, and is dropped once the pass is stale. */
const readOnDrainLane = (isCurrent: () => boolean) => <T,>(read: () => Promise<T>): Promise<T | null> =>
  enqueueDrainWork(() => isCurrent() ? read() : Promise.resolve(null));

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
onPendingSnapshot?: (rows: readonly TranscriberListRow[], savedIds: readonly string[]) => Promise<void>;
}): Promise<void> {
  const { tcw, client, saver = defaultSaver, isCurrent = () => true, onState = () => {}, observedSaved,
    deliveryActive = serverDeliveryActive, now = Date.now, refreshBackoff = new Map() } = input;
  const failedRefresh = (id: string) => {
    const failures = (refreshBackoff.get(id)?.failures ?? 0) + 1;
    refreshBackoff.set(id, { failures, retryAt: now() + Math.min(30 * 60_000, 60_000 * 2 ** (failures - 1)) });
  };
  if (!isCurrent()) return;
  // This API call can be slow or retry for tens of seconds; it does not touch
  // the user's space and must never occupy the serial space-write lane.
  const listed = await client.list();
  if (listed.status !== "ok" || !isCurrent()) return;
  // Each SQL/KV completeness read takes its own turn. A library with many
  // saved recordings therefore yields the lane between keys for voice notes.
  const complete = await saver.listSaved(tcw, readOnDrainLane(isCurrent), isCurrent);
  if (!complete?.ok || !isCurrent()) return;
  const versions = saver.listVersions
    ? await saver.listVersions(tcw, readOnDrainLane(isCurrent))
    : { ok: false as const };
  if (!isCurrent()) return;
  const saved = new Set(complete.data ?? []);
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
      if (versions.ok && Number.isInteger(version) && version! > (versions.data.get(row.id) ?? 1)
        && refreshes < 3 && !inGrace && (refreshBackoff.get(row.id)?.retryAt ?? 0) <= now()) {
        refreshes++;
        onState(row.id, "saving");
        try {
          const fetched = await client.transcript(row.id);
          if (!isCurrent()) return;
          if (fetched.status === "ok" && fetched.value.status === "ready"
            && fetched.value.transcript.version === version) {
            const fetchedTranscript = fetched.value.transcript;
            const result = await enqueueDrainWork(() => isCurrent()
              ? (saver.refresh ?? refreshTranscriberMeeting)(tcw, row, fetchedTranscript, async () => {
                const latest = await client.transcript(row.id);
                return isCurrent() && latest.status === "ok" && latest.value.status === "ready"
                  ? latest.value.transcript : null;
              })
              : Promise.resolve(null));
            if (!isCurrent()) return;
            onState(row.id, result?.ok ? "saved" : "error");
            if (result?.ok) {
              refreshBackoff.delete(row.id);
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
      const result = await client.transcript(row.id);
      if (!isCurrent()) return;
      let ok = false;
      if (result.status === "ok" && result.value.status === "ready") {
        const fetchedTranscript = result.value.transcript;
        const saved = await enqueueDrainWork(async () => {
          if (!isCurrent()) return null;
          return saver.save(tcw, row, fetchedTranscript);
        });
        ok = saved?.ok === true;
      }
      if (!isCurrent()) return;
      if (ok) {
        saved.add(row.id);
        observedSaved?.ids.add(row.id);
        captureEvents.emit("library-changed", { source: TRANSCRIBER_MEETING_SOURCE, sourceId: row.id });
      }
      onState(row.id, ok ? "saved" : "error");
    } catch {
      // One broken recording must not starve the rest or leak error payloads.
      if (isCurrent()) onState(row.id, "error");
    }
  }
  if (isCurrent()) await input.onPendingSnapshot?.(listed.value.meetings, [...saved]);
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
    const refreshBackoff: TranscriberRefreshBackoff = new Map();
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
    const isCurrent = accountCurrent;
    const run = () => {
      if (!sessionCurrent() || running || (!unlocked() && observedSaved.initialized)) return;
      running = true;
      void (async () => {
        // Meeting storage is readable with the vault locked. Snapshot now so
        // another device's saves during the lock are not part of the baseline.
        if (!observedSaved.initialized && !unlocked()) {
          const baseline = await saver.listSaved(tcw, readOnDrainLane(accountCurrent), accountCurrent);
          if (baseline?.ok && accountCurrent()) {
            for (const id of baseline.data ?? []) observedSaved.ids.add(id);
            observedSaved.initialized = true;
          }
        }
        if (sessionCurrent() && unlocked()) {
          // Each save takes the drain lane itself; the pass as a whole does not hold it.
          await syncTranscriberLibrary({
            tcw, client: api, saver, isCurrent, observedSaved, refreshBackoff, onState: (id, state) => {
              if (accountCurrent()) setSaved((old) => ({ ...old, [id]: state }));
            },
            onPendingSnapshot: async (rows, savedIds) => {
              if (!accountCurrent()) return;
              await enqueueDrainWork(() => accountCurrent()
                ? writePendingReconcileSnapshot(tcw.kv, "transcriber", transcriberPendingRows(rows, savedIds), undefined, accountCurrent)
                : Promise.resolve({ ok: true, changed: false }));
            },
          });
        }
      })().catch(() => { /* The next wake retries failures outside an individual recording. */ })
        .finally(() => { running = false; });
    };
    run();
    const unsubscribe = onSecretsUnlocked(run);
    const timer = window.setInterval(run, TRANSCRIBER_LIBRARY_RETRY_MS);
    const onReturn = () => { if (document.visibilityState === "visible") run(); };
    window.addEventListener("focus", run);
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      cancelled = true;
      unsubscribe();
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
