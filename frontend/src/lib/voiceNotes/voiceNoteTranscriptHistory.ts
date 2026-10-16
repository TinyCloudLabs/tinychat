import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_KV_PREFIX } from "../connectors/connectorStore";
import { readTranscriptCommit, type TranscriptCommit } from "./voiceNoteCommits";
import { withVoiceNoteSaveDeadline } from "./saveDeadline";

export interface VoiceNoteTranscriptHistoryRecord {
  v: 1;
  rev: number;
  hash: string;
  body_key: string;
  outcome: "transcribed" | "no_speech";
  engine: string | null;
  provider: string | null;
  committed_at: string | null;
}

export function transcriptHistoryKvKey(sourceId: string, rev: number, hash: string): string {
  return `${CONNECTORS_KV_PREFIX}/exo-voice-note/transcript-history/${sourceId}/${rev}/${hash}`;
}

function isSameRecord(value: unknown, expected: VoiceNoteTranscriptHistoryRecord): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expectedKeys = Object.keys(expected);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => record[key] === expected[key as keyof VoiceNoteTranscriptHistoryRecord]);
}

function existingRecordText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return null;
}

/** Preserve a verified committed revision before a held replacement or explicit rerun. */
export async function preserveVoiceNoteTranscriptHistory(tcw: TinyCloudWeb, expected: TranscriptCommit,
  checkpoint: () => void): Promise<void> {
  checkpoint();
  const current = await withVoiceNoteSaveDeadline(`transcript history commit id=${expected.sourceId}`,
    (signal) => readTranscriptCommit(tcw, expected.sourceId, checkpoint, signal));
  checkpoint();
  if (current?.rev !== expected.rev || current.hash !== expected.hash)
    throw new Error("The committed transcript changed before history could be preserved. Retry the rerun.");
  const record: VoiceNoteTranscriptHistoryRecord = {
    v: 1,
    rev: expected.rev,
    hash: expected.hash,
    body_key: expected.bodyKey,
    outcome: expected.outcome,
    engine: expected.engine,
    provider: expected.provider,
    committed_at: expected.committedAt,
  };
  const key = transcriptHistoryKvKey(expected.sourceId, expected.rev, expected.hash);
  checkpoint();
  const result = await tcw.kv.put(key, JSON.stringify(record), { ifNoneMatch: "*", contentType: "application/json" });
  if (result.ok) return;
  if (!/PRECONDITION|412/i.test(`${result.error.code} ${result.error.message}`))
    throw new Error("Could not preserve the current transcript revision", { cause: result.error });

  const existing = await tcw.kv.get(key);
  if (!existing.ok) throw new Error("Could not verify the existing transcript history record");
  const text = existingRecordText(existing.data.data);
  if (text === null) throw new Error("The existing transcript history record is unreadable");
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new Error("The existing transcript history record is invalid"); }
  if (!isSameRecord(value, record)) throw new Error("The transcript history record conflicts with the current revision");
}
