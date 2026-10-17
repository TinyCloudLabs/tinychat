// Keeps this device's recording settings and the account's synced document in step. The document lives in the user's own
// TinyCloud space (the `settings` SQL table); nothing here talks to the tinychat backend. localStorage and the capture
// engine's copy stay the instant, offline-capable cache that every reader uses.
import { useEffect } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSetting, setSetting } from "../threadStore";
import { RECORDING_SETTING_KEY, parseRecordingDoc, reconcile, serializeRecordingDoc } from "./recordingSettings";
import { markSynced, readLocalState, setActiveAccount, subscribeRecordingEdits } from "./recordingSettingsLocal";
import { adoptSyncedFields } from "./transcriberPreference";

// An edit that lands while a cycle is talking to the space makes that cycle's plan stale: it runs again.
const MAX_ATTEMPTS = 3;

let lane: Promise<void> = Promise.resolve();

async function cycle(tcw: TinyCloudWeb, account: string, isCurrent: () => boolean): Promise<"done" | "stale"> {
  const parsed = parseRecordingDoc(await getSetting(tcw, RECORDING_SETTING_KEY));
  // A document from a newer app is left exactly as it is.
  if (parsed.kind === "newer-version" || !isCurrent()) return "done";
  const local = readLocalState();
  if (!local) return "done";
  const plan = reconcile(local, parsed.kind === "doc" ? parsed.doc : null, account, Date.now());
  if (readLocalState()?.at !== local.at) return "stale";
  if (Object.keys(plan.adopt).length > 0) await adoptSyncedFields(plan.adopt);
  if (plan.write) await setSetting(tcw, RECORDING_SETTING_KEY, serializeRecordingDoc(plan.write));
  // An edit during the writes above keeps its own stamp and dirty fields; its own cycle pushes it.
  if (readLocalState()?.at !== local.at) return "stale";
  if (plan.claim) markSynced(plan.stamp, account);
  return "done";
}

/**
 * One sync of the recording settings with the account's space, queued behind any already running. Never rejects: a
 * failed read or write (offline, no access) leaves the cache as it is, and the next trigger tries again.
 */
export function syncRecordingSettings(tcw: TinyCloudWeb, isCurrent: () => boolean = () => true): Promise<void> {
  const account = tcw.did;
  if (!account) return Promise.resolve();
  const run = lane.then(async () => {
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS && isCurrent(); attempt++) {
        if (await cycle(tcw, account, isCurrent) === "done") return;
      }
    } catch (caught) {
      console.warn("[RecordingSettings] Could not sync with your TinyCloud space; this device keeps its own copy for now", caught);
    }
  });
  lane = run;
  return run;
}

/** Sync now and on every later local edit, when the tab becomes visible and when the network returns. Returns the detach. */
export function attachRecordingSettingsSync(tcw: TinyCloudWeb): () => void {
  let attached = true;
  const run = () => { void syncRecordingSettings(tcw, () => attached); };
  const onVisible = () => { if (document.visibilityState === "visible") run(); };
  setActiveAccount(tcw.did ?? null);
  const offEdits = subscribeRecordingEdits(run);
  document.addEventListener("visibilitychange", onVisible);
  globalThis.addEventListener("online", run);
  run();
  return () => {
    attached = false;
    setActiveAccount(null);
    offEdits();
    document.removeEventListener("visibilitychange", onVisible);
    globalThis.removeEventListener("online", run);
  };
}

/** Signed in: this account's recording settings follow the account across devices. */
export function useRecordingSettingsSync(tcw: TinyCloudWeb | null): void {
  useEffect(() => (tcw ? attachRecordingSettingsSync(tcw) : undefined), [tcw]);
}
