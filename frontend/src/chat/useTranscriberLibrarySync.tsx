import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createTranscriberClient, type TranscriberClient, type TranscriberMeeting, type TranscriberTranscript } from "@/lib/transcriberApi";
import { listSavedTranscriberMeetingIds, saveTranscriberMeeting } from "@/lib/transcriberSave";
import { isSecretsUnlocked, onSecretsUnlocked } from "@/lib/connectors/connectorSecrets";
import { enqueueDrainWork } from "./useBackgroundDrain";

export type TranscriberSaveState = "saving" | "saved" | "error";
export const TRANSCRIBER_LIBRARY_RETRY_MS = 30_000;
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
  onState?: (id: string, state: TranscriberSaveState) => void;
}): Promise<void> {
  const { tcw, client, saver = defaultSaver, isCurrent = () => true, onState = () => {} } = input;
  if (!isCurrent()) return;
  const listed = await client.list();
  if (listed.status !== "ok" || !isCurrent()) return;
  const complete = await saver.listSaved(tcw);
  if (!complete.ok || !isCurrent()) return;
  const saved = new Set(complete.data ?? []);
  for (const row of listed.value.meetings) {
    if (!isCurrent()) return;
    if ("unavailable" in row || row.status !== "completed") continue;
    if (saved.has(row.id)) { onState(row.id, "saved"); continue; }
    onState(row.id, "saving");
    try {
      const result = await client.transcript(row.id);
      if (!isCurrent()) return;
      const ok = result.status === "ok" && result.value.status === "ready"
        && (await saver.save(tcw, row, result.value.transcript)).ok;
      if (isCurrent()) onState(row.id, ok ? "saved" : "error");
    } catch {
      // One broken recording must not starve the rest or leak error payloads.
      if (isCurrent()) onState(row.id, "error");
    }
  }
}

export function useTranscriberLibrarySync(input: {
  tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore; enabled?: boolean;
}): Readonly<Record<string, TranscriberSaveState>> {
  const { tcw, backendUrl, sessionStore, enabled = true } = input;
  const api = useMemo(() => createTranscriberClient(backendUrl, { sessionStore }), [backendUrl, sessionStore]);
  const [saved, setSaved] = useState<Record<string, TranscriberSaveState>>({});
  const running = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setSaved({});
    const isCurrent = () => enabled && !cancelled && !!sessionStore.getToken()
      && !sessionStore.isExpired() && isSecretsUnlocked(tcw);
    const run = () => {
      if (!isCurrent() || running.current) return;
      running.current = true;
      void enqueueDrainWork(async () => {
        await syncTranscriberLibrary({ tcw, client: api, isCurrent, onState: (id, state) => {
          if (!cancelled) setSaved((old) => ({ ...old, [id]: state }));
        } });
      }).catch(() => { /* The next wake retries failures outside an individual recording. */ })
        .finally(() => { running.current = false; });
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
  }, [api, tcw, sessionStore, enabled]);
  return saved;
}

/** Mounted once in the authenticated app shell; Sources only consumes its progress. */
export function TranscriberLibrarySyncProvider(props: {
  tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore; enabled?: boolean; children: ReactNode;
}) {
  const saved = useTranscriberLibrarySync(props);
  return <SavedContext.Provider value={saved}>{props.children}</SavedContext.Provider>;
}
