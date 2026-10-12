import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createTranscriberClient, type TranscriberClient, type TranscriberMeeting, type TranscriberTranscript } from "@/lib/transcriberApi";
import { listSavedTranscriberMeetingIds, saveTranscriberMeeting, TRANSCRIBER_MEETING_SOURCE } from "@/lib/transcriberSave";
import { isSecretsUnlocked, onSecretsUnlocked } from "@/lib/connectors/connectorSecrets";
import { secretsAvailable } from "@/lib/openkeyNative";
import { captureEvents } from "@/capture/captureEvents";
import { enqueueDrainWork } from "./useBackgroundDrain";
import { serverDeliveryActive } from "@/lib/transcriptDeliveryState";

export type TranscriberSaveState = "saving" | "saved" | "error";
export const TRANSCRIBER_LIBRARY_RETRY_MS = 30_000;
const SERVER_DELIVERY_GRACE_MS = 10 * 60_000;
const SavedContext = createContext<Readonly<Record<string, TranscriberSaveState>>>({});
export const useTranscriberSavedState = () => useContext(SavedContext);

export interface TranscriberLibrarySaver {
  listSaved(tcw: TinyCloudWeb): Promise<{ ok: boolean; data?: string[] }>;
  save(tcw: TinyCloudWeb, meeting: TranscriberMeeting, transcript: TranscriberTranscript): Promise<{ ok: boolean }>;
}
const defaultSaver: TranscriberLibrarySaver = { listSaved: listSavedTranscriberMeetingIds, save: saveTranscriberMeeting };

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
}): Promise<void> {
  const { tcw, client, saver = defaultSaver, isCurrent = () => true, onState = () => {}, observedSaved,
    deliveryActive = serverDeliveryActive, now = Date.now } = input;
  if (!isCurrent()) return;
  const listed = await client.list();
  if (listed.status !== "ok" || !isCurrent()) return;
  const complete = await saver.listSaved(tcw);
  if (!complete.ok || !isCurrent()) return;
  const saved = new Set(complete.data ?? []);
  if (observedSaved && !observedSaved.initialized) {
    for (const id of saved) observedSaved.ids.add(id);
    observedSaved.initialized = true;
  }
  for (const row of listed.value.meetings) {
    if (!isCurrent()) return;
    if ("unavailable" in row || row.status !== "completed") continue;
    if (saved.has(row.id)) {
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
      const ok = result.status === "ok" && result.value.status === "ready"
        && (await saver.save(tcw, row, result.value.transcript)).ok;
      if (!isCurrent()) return;
      if (ok) {
        captureEvents.emit("library-changed", { source: TRANSCRIBER_MEETING_SOURCE, sourceId: row.id });
        observedSaved?.ids.add(row.id);
      }
      onState(row.id, ok ? "saved" : "error");
    } catch {
      // One broken recording must not starve the rest or leak error payloads.
      if (isCurrent()) onState(row.id, "error");
    }
  }
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
          const baseline = await saver.listSaved(tcw);
          if (baseline.ok && accountCurrent()) {
            for (const id of baseline.data ?? []) observedSaved.ids.add(id);
            observedSaved.initialized = true;
          }
        }
        if (sessionCurrent() && unlocked()) {
          await enqueueDrainWork(() => syncTranscriberLibrary({
            tcw, client: api, saver, isCurrent, observedSaved, onState: (id, state) => {
              if (accountCurrent()) setSaved((old) => ({ ...old, [id]: state }));
            },
          }));
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
