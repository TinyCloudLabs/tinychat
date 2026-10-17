// Keeps this device's recording settings and the account's synced document in step. The document lives in the user's own
// TinyCloud space (the `settings` SQL table); nothing here talks to the tinychat backend. localStorage and the capture
// engine's copy stay the instant, offline-capable cache that every reader uses.
import { useEffect } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSetting, setSetting } from "../threadStore";
import { RECORDING_SETTING_KEY, parseRecordingDoc, reconcile, serializeRecordingDoc } from "./recordingSettings";
import { dropSyncedKeys, markSynced, notifyRecordingSettings, readLocalState, setActiveAccount, subscribeRecordingEdits } from "./recordingSettingsLocal";
import { captureEngineAvailable } from "./captureEngine";
import { adoptSyncedFields, refreshEffectiveTranscriber } from "./transcriberPreference";

// An edit that lands while a cycle is talking to the space makes that cycle's plan stale: it runs again.
const MAX_ATTEMPTS = 3;

let lane: Promise<void> = Promise.resolve();

/**
 * The values on this device belong to the account that last synced or edited here. Another account signing in starts
 * from defaults: it never sees them, and they are never written to its space. The capture engine's copy follows.
 */
function forgetForeignCache(account: string): void {
  const owner = readLocalState()?.owner ?? null;
  if (owner === null || owner === account) return;
  dropSyncedKeys();
  notifyRecordingSettings();
  if (captureEngineAvailable()) {
    void refreshEffectiveTranscriber().catch((caught: unknown) => console.warn("[RecordingSettings] Could not reset the engine's default", caught));
  }
}

async function cycle(tcw: TinyCloudWeb, account: string, isCurrent: () => boolean): Promise<"done" | "stale"> {
  forgetForeignCache(account);
  const parsed = parseRecordingDoc(await getSetting(tcw, RECORDING_SETTING_KEY));
  // A document from a newer app is left exactly as it is.
  if (parsed.kind === "newer-version" || !isCurrent()) return "done";
  const local = readLocalState();
  if (!local) return "done";
  const plan = reconcile(local, parsed.kind === "doc" ? parsed.doc : null, Date.now());
  if (readLocalState()?.at !== local.at) return "stale";
  // A refusal by the capture engine must not hold back pushing this device's edits; the cycle just is not marked synced.
  let adopted = true;
  if (Object.keys(plan.adopt).length > 0) {
    try { await adoptSyncedFields(plan.adopt); } catch (caught) {
      adopted = false;
      console.warn("[RecordingSettings] The recorder did not take the synced defaults yet; trying again later", caught);
    }
  }
  if (plan.write) await setSetting(tcw, RECORDING_SETTING_KEY, serializeRecordingDoc(plan.write));
  // An edit during the writes above keeps its own stamp and dirty fields; its own cycle pushes it.
  if (readLocalState()?.at !== local.at) return "stale";
  if (adopted) markSynced(plan.stamp, account);
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
  if (tcw.did) forgetForeignCache(tcw.did);
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
