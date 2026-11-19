// What the latest Google Meet run in this page load left behind: when it ended and how it ended.
//
// The connection row's `last_synced_at` is the sync WATERMARK (a run's start time, kept on a failure),
// and the row is only re-read after a run settles. Read as a status line, the two lag the run: a
// finished sync shows the previous failure, or the time it began. The engine tells this module what it
// just wrote, and the Meeting sources window shows that instead of the leftover row.
//
// ONE ACCOUNT, ONE ENTRY (TC-1376): keyed by the account DID, like the live count.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

export interface GmeetLastRun {
  /** When the latest run that completed the Meet records ended (ISO). Kept across a later run that failed. */
  syncedAt: string | null;
  /** How the latest run ended: clean, with some Notes unsaved, or failed. */
  status: "ok" | "partial" | "error";
  /** The message the row shows for `partial` and `error`. */
  error: string | null;
}

const runs = new Map<string, GmeetLastRun>();
const listeners = new Set<() => void>();

export function getGmeetLastRun(tcw: TinyCloudWeb | null): GmeetLastRun | null {
  const did = tcw?.did;
  return did ? (runs.get(did) ?? null) : null;
}

export function onGmeetLastRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* A subscriber's failure must not reach the engine. */ }
  }
}

/** Records how a run ended. A run that did not complete (`syncedAt` null) keeps the previous end time. */
export function publishGmeetLastRun(tcw: TinyCloudWeb, run: GmeetLastRun): void {
  const did = tcw.did;
  if (!did) return;
  runs.set(did, { ...run, syncedAt: run.syncedAt ?? runs.get(did)?.syncedAt ?? null });
  notify();
}

/** The account's connection is gone: its last run says nothing about the next one. */
export function clearGmeetLastRun(tcw: TinyCloudWeb): void {
  const did = tcw.did;
  if (did && runs.delete(did)) notify();
}

/** Tests only. */
export function resetGmeetLastRunsForTests(): void {
  runs.clear();
  listeners.clear();
}
