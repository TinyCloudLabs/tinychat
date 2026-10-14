import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_KV_PREFIX } from "../connectors/connectorStore";
import type { TranscriptCommit } from "./voiceNoteCommits";

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

export function transcriptHistoryKvKey(sourceId: string, rev: number): string {
  return `${CONNECTORS_KV_PREFIX}/exo-voice-note/transcript-history/${sourceId}/${rev}`;
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

/** Call only for an explicit UI rerun, after reading the current commit and before its replacement commits. */
export async function preserveVoiceNoteTranscriptHistory(tcw: TinyCloudWeb, commit: TranscriptCommit): Promise<void> {
  const record: VoiceNoteTranscriptHistoryRecord = {
    v: 1,
    rev: commit.rev,
    hash: commit.hash,
    body_key: commit.bodyKey,
    outcome: commit.outcome,
    engine: commit.engine,
    provider: commit.provider,
    committed_at: commit.committedAt,
  };
  const key = transcriptHistoryKvKey(commit.sourceId, commit.rev);
  const result = await tcw.kv.put(key, JSON.stringify(record), { ifNoneMatch: "*", contentType: "application/json" });
  if (result.ok) return;
  if (!/PRECONDITION|412/i.test(`${result.error.code} ${result.error.message}`))
    throw new Error("Could not preserve the current transcript revision");

  const existing = await tcw.kv.get(key);
  if (!existing.ok) throw new Error("Could not verify the existing transcript history record");
  const text = existingRecordText(existing.data.data);
  if (text === null) throw new Error("The existing transcript history record is unreadable");
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new Error("The existing transcript history record is invalid"); }
  if (!isSameRecord(value, record)) throw new Error("The transcript history record conflicts with the current revision");
}
