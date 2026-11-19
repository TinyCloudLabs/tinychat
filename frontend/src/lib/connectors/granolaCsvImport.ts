// Import meetings from a Granola CSV export into the owner's space.
//
// The write is the existing Granola meeting upsert (`connectorStore.upsertMeeting`:
// deterministic row id, idempotent, refreshes rather than duplicates). Before
// every write the meeting goes through the same purge check Fireflies uses
// (backend `isTombstoned`, via `POST /purge-check` with `source: "granola"`), so
// a meeting the owner deleted stays out until they allow deleted meetings back.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  granolaCsvDedupeKey,
  normalizeGranolaCsvRow,
  parseGranolaCsv,
  type GranolaCsvError,
} from "./granolaCsv";
import type { NormalizedMeeting, StoreError, StoreResult, UpsertMeetingOutcome } from "./connectorStore";
import { isStorageFullError } from "../storageStatus";
import { runGranolaSpaceWrite } from "./granolaSync";
import type { TranscriptSentence } from "@tinyboilerplate/core";

/** Same shape as the Fireflies purge check; `true` means the meeting was deleted and must stay out. */
export type GranolaPurgeCheck = (meetingId: string, sourceTimestamp: string | null) => Promise<boolean>;

export interface GranolaCsvImportStore {
  ensureSchema(tcw: TinyCloudWeb): Promise<StoreResult<void>>;
  upsertMeeting(
    tcw: TinyCloudWeb,
    meeting: NormalizedMeeting,
    sentences: TranscriptSentence[],
  ): Promise<StoreResult<UpsertMeetingOutcome>>;
}

export interface GranolaCsvImportOptions {
  tcw: TinyCloudWeb;
  store: GranolaCsvImportStore;
  /** The file's text. */
  text: string;
  checkPurge: GranolaPurgeCheck;
  signal?: AbortSignal;
  onProgress?: (progress: { done: number; total: number }) => void;
}

export interface GranolaCsvImportCounts {
  /** Meetings stored for the first time. */
  added: number;
  /** Meetings the space already had. */
  alreadyImported: number;
  /** Repeats of an earlier row in the same file. */
  duplicatesInFile: number;
  /** Meetings the owner deleted earlier. */
  skippedDeleted: number;
  /** Rows with no title, summary or transcript. */
  blank: number;
  /** Rows that could not be stored. */
  failed: number;
}

export type GranolaCsvImportFailure =
  | { kind: "malformed"; csv: GranolaCsvError }
  | { kind: "purge-check" }
  | { kind: "storage"; full: boolean }
  | { kind: "aborted" };

export type GranolaCsvImportResult =
  | { ok: true; data: GranolaCsvImportCounts }
  | { ok: false; error: GranolaCsvImportFailure; partial: GranolaCsvImportCounts };

function emptyCounts(): GranolaCsvImportCounts {
  return { added: 0, alreadyImported: 0, duplicatesInFile: 0, skippedDeleted: 0, blank: 0, failed: 0 };
}

function storageFailure(error: StoreError): GranolaCsvImportFailure {
  return { kind: "storage", full: isStorageFullError(error) };
}

/**
 * Parse first, store second: a file that does not parse stores nothing. Rows are
 * written one at a time, oldest listing order, through the space lane.
 */
export async function importGranolaCsv(opts: GranolaCsvImportOptions): Promise<GranolaCsvImportResult> {
  const counts = emptyCounts();
  const parsed = parseGranolaCsv(opts.text);
  if (!parsed.ok) return { ok: false, error: { kind: "malformed", csv: parsed.error }, partial: counts };
  counts.blank = parsed.data.blank;

  const schema = await runGranolaSpaceWrite(() => opts.store.ensureSchema(opts.tcw));
  if (!schema.ok) return { ok: false, error: storageFailure(schema.error), partial: counts };

  const rows = parsed.data.rows;
  const seen = new Set<string>();
  let done = 0;
  for (const row of rows) {
    if (opts.signal?.aborted) return { ok: false, error: { kind: "aborted" }, partial: counts };
    opts.onProgress?.({ done, total: rows.length });
    done++;
    const key = await granolaCsvDedupeKey(row);
    if (seen.has(key)) { counts.duplicatesInFile++; continue; }
    seen.add(key);

    const { meeting, sentences } = await normalizeGranolaCsvRow(row);
    let blocked: boolean;
    try {
      blocked = await opts.checkPurge(meeting.sourceId, meeting.startedAt);
    } catch {
      return { ok: false, error: { kind: "purge-check" }, partial: counts };
    }
    if (blocked) { counts.skippedDeleted++; continue; }

    const write = await runGranolaSpaceWrite(() => opts.store.upsertMeeting(opts.tcw, meeting, sentences));
    if (!write.ok) {
      counts.failed++;
      if (isStorageFullError(write.error)) return { ok: false, error: storageFailure(write.error), partial: counts };
      continue;
    }
    if (write.data.skippedDeleted) counts.skippedDeleted++;
    else if (write.data.inserted) counts.added++;
    else counts.alreadyImported++;
  }
  opts.onProgress?.({ done, total: rows.length });
  return { ok: true, data: counts };
}
