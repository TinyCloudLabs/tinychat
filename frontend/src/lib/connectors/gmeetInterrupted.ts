// A Notes sync a reload (or a closed tab) cut short, read back from its stored checkpoint.
//
// The checkpoint lives in the account's own space (`connectorStore.getDriveProgress`), so it is read
// through the `tcw` of the account asking: another account's checkpoint is never reachable from here
// (TC-1376). Nothing in the page's memory is consulted, which is the point: after a reload the engine
// has no run, only what it wrote down.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { GmeetDriveProgress, StoreResult } from "./connectorStore";
import { CHECKPOINT_MAX_AGE_MS } from "./gmeetSync";

export interface GmeetInterrupted {
  /** Notes already saved by the interrupted run. */
  done: number;
  /** Notes the run had to go through; null for a checkpoint written before the total was recorded. */
  total: number | null;
}

/** The interrupted run's position, or null when there is no checkpoint or it is too old to be resumed. */
export async function readGmeetInterrupted(
  tcw: TinyCloudWeb,
  getProgress: (tcw: TinyCloudWeb, source: string) => Promise<StoreResult<GmeetDriveProgress | null>>,
  now: () => number = Date.now,
): Promise<GmeetInterrupted | null> {
  const res = await getProgress(tcw, "google-meet");
  if (!res.ok || res.data === null) return null;
  const savedAt = Date.parse(res.data.savedAt);
  if (!Number.isFinite(savedAt) || savedAt <= now() - CHECKPOINT_MAX_AGE_MS) return null;
  return { done: res.data.doneIds.length, total: res.data.total ?? null };
}

export function describeGmeetInterrupted(interrupted: GmeetInterrupted): string {
  const at = interrupted.total === null ? `after ${interrupted.done} Notes` : `at ${interrupted.done}/${interrupted.total}`;
  return `A Notes sync was interrupted ${at}. Sync now resumes it.`;
}
