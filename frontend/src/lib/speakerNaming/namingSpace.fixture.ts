// A real in-memory space for the naming tests: SQLite behind `tcw.sql` and a map behind `tcw.kv`, with voice notes
// saved and committed by the app's own writers, so a test reads what a device would.
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { ensureSchema } from "@/lib/connectors/connectorStore";
import { commitVoiceNoteTranscript, createVoiceNoteRow } from "@/lib/voiceNotes/voiceNoteRows";

let count = 0;

/** A call on a Mac: the user on the microphone channel, two people on the other, each long enough to be named. */
export const CALL: FirefliesSentence[] = [
  { index: 0, speaker_name: "Me", channel: 0, text: "Hi, thanks for joining. Who wants to start?", start_time: 0, end_time: 5 },
  { index: 1, speaker_name: "Speaker 1", channel: 1, speaker_id: "A", text: "Sure. I'm Alice Chen and I run the offsite planning.", start_time: 6, end_time: 20 },
  { index: 2, speaker_name: "Speaker 2", channel: 1, speaker_id: "B", text: "And this is Bob Stone. I will take the catering quote.", start_time: 21, end_time: 35 },
  { index: 3, speaker_name: "Me", channel: 0, text: "Thank you both.", start_time: 36, end_time: 38 },
];

/** A model reply naming CALL's two remote speakers (the model sees S1, S2, S3 in order of first appearance). */
export const CALL_REPLY = JSON.stringify({ speakers: [
  { speaker: "S1", name: "null", basis: "none", quote: "" },
  { speaker: "S2", name: "Alice Chen", basis: "self-introduction", quote: "I'm Alice Chen" },
  { speaker: "S3", name: "Bob Stone", basis: "self-introduction", quote: "this is Bob Stone" },
] });

export function namingSpace() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  /** Every SQL statement the space was asked to run, in order. */
  const statements: string[] = [];
  const did = `did:test:naming-${++count}`;
  const sql = {
    db: () => ({
      async query(statement: string, params: unknown[] = []) {
        statements.push(statement);
        try { return { ok: true, data: { rows: sqlite.prepare(statement).all(...params as never[]).map((r) => Object.values(r as object)) } }; }
        catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
      },
      async execute(statement: string, params: unknown[] = []) {
        statements.push(statement);
        try { return { ok: true, data: { changes: sqlite.prepare(statement).run(...params as never[]).changes } }; }
        catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
      },
    }),
  };
  const kv = {
    async put(key: string, value: string, options?: { ifNoneMatch?: string }) {
      if (options?.ifNoneMatch === "*" && values.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "412" } };
      values.set(key, value);
      return { ok: true, data: {} };
    },
    async get(key: string) {
      return values.has(key) ? { ok: true, data: { data: values.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
    },
    async list({ path }: { path: string }) {
      return { ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)), truncated: false } };
    },
  };
  const tcw = { did, spaceId: did, sql, kv } as unknown as TinyCloudWeb;
  const revs = new Map<string, number>();
  const row = (sourceId: string) => sqlite.query("SELECT id, metadata, updated_at FROM connector_meeting WHERE source = 'exo-voice-note' AND source_id = ?")
    .get(sourceId) as { id: string; metadata: string; updated_at: string };
  return {
    tcw, sqlite, statements,
    /** Saves a voice note and commits `sentences` as its transcript (a later call commits a new revision). Returns the revision's hash. */
    async note(sourceId: string, sentences: FirefliesSentence[], options: { engine?: string; startedAt?: string } = {}): Promise<string> {
      await ensureSchema(tcw);
      await createVoiceNoteRow(tcw, { id: sourceId, startedAt: Date.parse(options.startedAt ?? "2026-11-20T10:00:00.000Z"), durationMs: 40_000,
        mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Call");
      const rev = (revs.get(sourceId) ?? 0) + 1;
      revs.set(sourceId, rev);
      const committed = await commitVoiceNoteTranscript(tcw, sourceId, { rev, outcome: "transcribed", text: sentences.map((s) => s.text).join(" "),
        engine: options.engine ?? "private-cloud", sentences,
        participants: [...new Set(sentences.flatMap((s) => (s.speaker_name ? [s.speaker_name] : [])))] });
      return committed.hash;
    },
    /** A meeting a connector brought in. */
    meeting(source: string, id: string, startedAt: string, durationSecs: number, participants: unknown, metadata: Record<string, unknown> = {}) {
      sqlite.prepare(`INSERT INTO connector_meeting (id, source, source_id, title, started_at, duration_secs, participants, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'Meeting', ?, ?, ?, ?, ?, ?)`).run(`${source}-${id}`, source, id, startedAt, durationSecs, JSON.stringify(participants), JSON.stringify(metadata), startedAt, startedAt);
    },
    rowId: (sourceId: string) => row(sourceId).id,
    updatedAt: (sourceId: string) => row(sourceId).updated_at,
    /** The note row's metadata as stored. */
    metadata: (sourceId: string) => JSON.parse(row(sourceId).metadata) as Record<string, unknown>,
    setMetadata(sourceId: string, patch: Record<string, unknown>) {
      sqlite.prepare("UPDATE connector_meeting SET metadata = json_patch(metadata, ?) WHERE source = 'exo-voice-note' AND source_id = ?").run(JSON.stringify(patch), sourceId);
    },
  };
}

export type NamingSpace = ReturnType<typeof namingSpace>;
