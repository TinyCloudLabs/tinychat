// Keeps one account's recording settings and its synced document in step. The document lives in the user's own
// TinyCloud space (the `settings` SQL table); nothing here talks to the tinychat backend. Each account has its own
// cache on this device (recordingSettingsLocal.ts): a cycle is started for ONE account and reads and writes only that
// account's cache and that account's space, so no value can cross from one account to another.
import { useEffect } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSetting, setSetting } from "../threadStore";
import { RECORDING_SETTING_KEY, parseRecordingDoc, reconcile, serializeRecordingDoc } from "./recordingSettings";
import { currentScope, markSynced, readLocalState, readStamp, seedFromDevice, setActiveAccount, subscribeRecordingEdits } from "./recordingSettingsLocal";
import { adoptSyncedFields } from "./transcriberPreference";

// An edit that lands while a cycle is talking to the space makes that cycle's plan stale: it runs again.
const MAX_ATTEMPTS = 3;

let lane: Promise<void> = Promise.resolve();

async function cycle(tcw: TinyCloudWeb, account: string, isCurrent: () => boolean): Promise<"done" | "stale"> {
  seedFromDevice(account);
  const parsed = parseRecordingDoc(await getSetting(tcw, RECORDING_SETTING_KEY));
  // A document from a newer app is left exactly as it is.
  if (parsed.kind === "newer-version" || !isCurrent()) return "done";
  const local = readLocalState(account);
  const plan = reconcile(local, parsed.kind === "doc" ? parsed.doc : null, Date.now());
  if (readStamp(account).at !== local.at) return "stale";
  // A refusal by the capture engine must not hold back pushing this account's edits; the cycle just is not marked synced.
  let adopted = true;
  if (Object.keys(plan.adopt).length > 0) {
    try { await adoptSyncedFields(account, plan.adopt); } catch (caught) {
      adopted = false;
      console.warn("[RecordingSettings] The recorder did not take the synced defaults yet; trying again later", caught);
    }
  }
  if (plan.write) await setSetting(tcw, RECORDING_SETTING_KEY, serializeRecordingDoc(plan.write));
  // An edit during the writes above keeps its own stamp and dirty fields; its own cycle pushes it.
  if (readStamp(account).at !== local.at) return "stale";
  if (adopted) markSynced(account, plan.stamp);
  return "done";
}

/**
 * One sync of one account's recording settings with that account's space, queued behind any already running. Never
 * rejects: a failed read or write (offline, no access) leaves the cache as it is, and the next trigger tries again.
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

/** Sync now and on every later edit to this account's cache, when the tab becomes visible and when the network returns. Returns the detach. */
export function attachRecordingSettingsSync(tcw: TinyCloudWeb): () => void {
  let attached = true;
  const account = tcw.did;
  const run = () => { void syncRecordingSettings(tcw, () => attached); };
  const onVisible = () => { if (document.visibilityState === "visible") run(); };
  // Before anything can edit this account's cache: values the device held before accounts had their own seed it, once.
  if (account) seedFromDevice(account);
  setActiveAccount(account ?? null);
  const offEdits = subscribeRecordingEdits((edited) => { if (edited === account) run(); });
  document.addEventListener("visibilitychange", onVisible);
  globalThis.addEventListener("online", run);
  run();
  return () => {
    attached = false;
    if (currentScope() === account) setActiveAccount(null);
    offEdits();
    document.removeEventListener("visibilitychange", onVisible);
    globalThis.removeEventListener("online", run);
  };
}

/** Signed in: this account's recording settings follow the account across devices. */
export function useRecordingSettingsSync(tcw: TinyCloudWeb | null): void {
  useEffect(() => (tcw ? attachRecordingSettingsSync(tcw) : undefined), [tcw]);
}
