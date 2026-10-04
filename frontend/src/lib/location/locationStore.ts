// TC-524 location spike: samples in the user's own TinyCloud space.
//
// PROTOTYPE STORAGE, NOT THE PROPOSED MODEL. The manifest grants no location
// prefix, and this spike must not change the manifest, so batches go under the
// existing `connectors/` KV grant (as voice-note audio does):
//
//   KV  {APP_ID}/connectors/exo-location/{installId}/{YYYY-MM-DD}/{firstSeq}  → LocationBatch JSON
//
// One key per drained page of the native queue (samples and OS-state events
// together, so the stored trail says why it has gaps). The key is the page's
// first queue seq, zero-padded so keys sort in capture order. A page that was
// saved but not acked (the app died in between) is re-read from the same seq
// and overwrites its key with a superset, so retries never duplicate.
//
// Nothing here is a Library item and no SQL is written. The proposed model (a
// separate `location` grant, SQL rows, visits) is in mobile/docs/location-spike.md.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS_KV_PREFIX, type StoreResult } from "../connectors/connectorStore";
import type { LocationPlugin, LocationQueueEntry, LocationSample, LocationStateEvent } from "./nativeLocation";

export const LOCATION_SPIKE_SOURCE = "exo-location";

/** Entries per batch (one KV write). */
export const LOCATION_BATCH_LIMIT = 200;

/** Batches per sync run, so one call never holds the queue for long. */
export const LOCATION_SYNC_MAX_BATCHES = 10;

export interface LocationBatch {
  v: 1;
  kind: "exo-location-batch";
  /** Marks prototype data, to migrate or drop when the real model lands. */
  spike: "TC-524";
  platform: string;
  installId: string;
  firstSeq: number;
  lastSeq: number;
  savedAt: string;
  samples: LocationSample[];
  events: LocationStateEvent[];
}

/** `YYYY-MM-DD` (UTC) of a ms timestamp. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function locationBatchPrefix(installId: string, day?: string): string {
  return `${CONNECTORS_KV_PREFIX}/${LOCATION_SPIKE_SOURCE}/${installId}/${day === undefined ? "" : `${day}/`}`;
}

export function locationBatchKvKey(installId: string, firstAt: number, firstSeq: number): string {
  return `${locationBatchPrefix(installId, utcDay(firstAt))}${String(firstSeq).padStart(12, "0")}`;
}

/** One queue page as the batch stored in the space, and its key. Throws on an empty page. */
export function buildLocationBatch(
  device: { platform: string; installId: string },
  entries: LocationQueueEntry[],
  now: Date = new Date(),
): { key: string; batch: LocationBatch } {
  if (entries.length === 0) throw new Error("buildLocationBatch: no entries");
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const batch: LocationBatch = {
    v: 1,
    kind: "exo-location-batch",
    spike: "TC-524",
    platform: device.platform,
    installId: device.installId,
    firstSeq: first.seq,
    lastSeq: last.seq,
    savedAt: now.toISOString(),
    samples: sorted.filter((e): e is LocationSample & { seq: number } => e.kind === "sample"),
    events: sorted.filter((e): e is LocationStateEvent & { seq: number } => e.kind === "state"),
  };
  return { key: locationBatchKvKey(device.installId, first.at, first.seq), batch };
}

export interface LocationSyncResult {
  batches: number;
  entries: number;
  /** Entries still queued on the device. */
  pending: number;
  /** Keys written in this run, oldest first. */
  keys: string[];
}

let syncInFlight: Promise<StoreResult<LocationSyncResult>> | null = null;

/**
 * Drain the native queue into the space: read a page, write it as one batch,
 * ack it, repeat. Single-flight (TinyCloud drops concurrent responses), and
 * stops at the first failed write, leaving that page queued on the device.
 */
export function syncLocationQueue(
  tcw: TinyCloudWeb,
  plugin: Pick<LocationPlugin, "pending" | "ack">,
  device: { platform: string; installId: string },
  options: { limit?: number; maxBatches?: number; now?: () => Date } = {},
): Promise<StoreResult<LocationSyncResult>> {
  if (syncInFlight) return syncInFlight;
  const limit = options.limit ?? LOCATION_BATCH_LIMIT;
  const maxBatches = options.maxBatches ?? LOCATION_SYNC_MAX_BATCHES;
  const now = options.now ?? (() => new Date());
  syncInFlight = (async (): Promise<StoreResult<LocationSyncResult>> => {
    const result: LocationSyncResult = { batches: 0, entries: 0, pending: 0, keys: [] };
    for (let i = 0; i < maxBatches; i++) {
      let page: { entries: LocationQueueEntry[]; pending: number };
      try {
        page = await plugin.pending({ limit });
      } catch (caught) {
        return { ok: false, error: { code: "LOCATION_QUEUE_READ", message: `syncLocationQueue(pending): ${messageOf(caught)}` } };
      }
      result.pending = page.pending;
      if (page.entries.length === 0) break;
      const { key, batch } = buildLocationBatch(device, page.entries, now());
      const put = await tcw.kv.put(key, JSON.stringify(batch));
      if (!put.ok) {
        return {
          ok: false,
          error: { code: put.error.code ?? "STORE_ERROR", message: `syncLocationQueue(put ${key}): ${put.error.message}` },
        };
      }
      try {
        result.pending = (await plugin.ack({ throughSeq: batch.lastSeq })).pending;
      } catch (caught) {
        // Saved but not acked: the next run re-reads from the same seq and overwrites the same key.
        return { ok: false, error: { code: "LOCATION_QUEUE_ACK", message: `syncLocationQueue(ack): ${messageOf(caught)}` } };
      }
      result.batches += 1;
      result.entries += page.entries.length;
      result.keys.push(key);
      if (result.pending === 0) break;
    }
    return { ok: true, data: result };
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

/** Batch keys stored for this install on one UTC day, oldest first. */
export async function listLocationBatchKeys(
  tcw: TinyCloudWeb,
  installId: string,
  day: string,
): Promise<StoreResult<string[]>> {
  const path = locationBatchPrefix(installId, day);
  let page: Awaited<ReturnType<typeof tcw.kv.list>>;
  try {
    page = await tcw.kv.list({ path });
  } catch (caught) {
    return { ok: false, error: { code: "KV_LIST_TRANSPORT", message: `listLocationBatchKeys: ${messageOf(caught)}` } };
  }
  if (!page || page.ok !== true) {
    return { ok: false, error: { code: page?.error?.code ?? "STORE_ERROR", message: `listLocationBatchKeys: ${page?.error?.message ?? "unknown"}` } };
  }
  const keys = Array.isArray(page.data?.keys) ? page.data.keys.filter((k): k is string => typeof k === "string" && k.startsWith(path)) : [];
  return { ok: true, data: keys.sort() };
}

function messageOf(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (caught && typeof caught === "object" && "message" in caught && typeof caught.message === "string") return caught.message;
  return String(caught);
}
