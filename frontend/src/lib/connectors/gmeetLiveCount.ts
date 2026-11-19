// The live count of saved Google Meet meetings: the rows the Library shows, not the
// `connector_state.item_count` cached at the end of a sync.
//
// The cached figure is written when a run settles, so during a background Notes run (and
// after a run a reload cut short) it lags the rows that are already saved. This module keeps
// the last count this page load read or the engine took, and tells subscribers when it moves.
//
// ONE ACCOUNT, ONE ENTRY (TC-1376): counts are keyed by the account DID. Another account's
// count is never returned, and a `tcw` without a DID has none.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { StoreResult } from "./connectorStore";

const counts = new Map<string, number>();
const listeners = new Set<() => void>();

/** The last known saved-meeting count for this account, or null before the first read. */
export function getGmeetMeetingCount(tcw: TinyCloudWeb | null): number | null {
  const did = tcw?.did;
  return did ? (counts.get(did) ?? null) : null;
}

export function onGmeetMeetingCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishGmeetMeetingCount(tcw: TinyCloudWeb, count: number): void {
  const did = tcw.did;
  if (!did || counts.get(did) === count) return;
  counts.set(did, count);
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* A subscriber's failure must not reach the engine. */ }
  }
}

/** Reads the rows now (`count` is the store's `countMeetings`) and publishes the figure. A failed read leaves the last known one. */
export async function refreshGmeetMeetingCount(
  tcw: TinyCloudWeb,
  count: (tcw: TinyCloudWeb, source: string) => Promise<StoreResult<number>>,
): Promise<void> {
  const res = await count(tcw, "google-meet");
  if (res.ok) publishGmeetMeetingCount(tcw, res.data);
}

/** Tests only. */
export function resetGmeetMeetingCountsForTests(): void {
  counts.clear();
  listeners.clear();
}
