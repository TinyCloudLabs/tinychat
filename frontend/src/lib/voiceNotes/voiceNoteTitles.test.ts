import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { __resetStorageStatusForTests } from "@/lib/storageStatus";
import { CONNECTORS_SQL_DB_NAME, ensureSchema } from "../connectors/connectorStore";
import { commitVoiceNoteTranscript, createPastedTranscriptRow, createVoiceNoteRow } from "./voiceNoteRows";

afterEach(() => { __resetStorageStatusForTests(); });

const STARTED = new Date(2026, 9, 9, 10, 30).getTime();
const DEFAULT_TITLE = "Voice note · Oct 9";
const SENTENCES = [{ index: 0, speaker_name: "You", text: "Hello.", start_time: 0, end_time: 5 }];

let count = 0;
// Unique did per fake: ensureSchema memoizes table creation by did.
function fakeTcw() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = `did:test:titles-${++count}`;
  const sql = {
    db(name: string) {
      expect(name).toBe(CONNECTORS_SQL_DB_NAME);
      return {
        async query(statement: string, params: unknown[] = []) {
          try { return { ok: true, data: { rows: sqlite.prepare(statement).all(...params as never[]).map((r) => Object.values(r as object)) } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
        async execute(statement: string, params: unknown[] = []) {
          try { return { ok: true, data: { changes: sqlite.prepare(statement).run(...params as never[]).changes } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
      };
    },
  };
  const kv = {
    async put(key: string, value: string, options?: { ifNoneMatch?: string }) {
      if (options?.ifNoneMatch === "*" && values.has(key))
        return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "412" } };
      values.set(key, value);
      return { ok: true, data: {} };
    },
    async get(key: string) {
      return values.has(key) ? { ok: true, data: { data: values.get(key) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
    },
    async list({ path }: { path: string }) {
      return { ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)), truncated: false } };
    },
  };
  return { tcw: { did, spaceId: did, sql, kv } as unknown as TinyCloudWeb, sqlite };
}

function recording(id: string) {
  return { id, startedAt: STARTED, durationMs: 1_000, mimeType: "audio/mp4", sizeBytes: 4,
    silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
}

function stored(sqlite: Database, sourceId: string) {
  const r = sqlite.query("SELECT title, metadata FROM connector_meeting WHERE source_id = ?").get(sourceId) as { title: string; metadata: string };
  return { title: r.title, metadata: JSON.parse(r.metadata) as Record<string, unknown> };
}

describe("voice-note titles at commit", () => {
  test("a new recorded note is named with its date, model and participants once transcribed", async () => {
    const { tcw, sqlite } = fakeTcw();
    await ensureSchema(tcw);
    await createVoiceNoteRow(tcw, recording("rec-named"), DEFAULT_TITLE);
    expect(stored(sqlite, "rec-named").title).toBe(DEFAULT_TITLE);

    await commitVoiceNoteTranscript(tcw, "rec-named", { rev: 1, outcome: "transcribed", text: "Hello.", sentences: SENTENCES,
      model: "universal-2", participants: ["Alice Chen", "Speaker 2", "Bob"] });

    const note = stored(sqlite, "rec-named");
    expect(note.title).toBe("Oct 9 · AssemblyAI Universal-2 · Alice Chen, Bob");
    expect(note.metadata).not.toHaveProperty("title_auto");
    expect(note.metadata.transcription_outcome).toBe("transcribed");
  });

  test("a note with no model and no real names is named by its date only", async () => {
    const { tcw, sqlite } = fakeTcw();
    await ensureSchema(tcw);
    await createVoiceNoteRow(tcw, recording("rec-date"), DEFAULT_TITLE);
    await commitVoiceNoteTranscript(tcw, "rec-date", { rev: 1, outcome: "transcribed", text: "Hello.", sentences: SENTENCES,
      participants: ["Me", "Them"] });
    expect(stored(sqlite, "rec-date").title).toBe("Oct 9");
  });

  test("a later commit does not retitle a note that was already named", async () => {
    const { tcw, sqlite } = fakeTcw();
    await ensureSchema(tcw);
    await createVoiceNoteRow(tcw, recording("rec-once"), DEFAULT_TITLE);
    await commitVoiceNoteTranscript(tcw, "rec-once", { rev: 1, outcome: "transcribed", text: "Hello.", sentences: SENTENCES,
      model: "universal-2", participants: ["Alice Chen"] });
    await commitVoiceNoteTranscript(tcw, "rec-once", { rev: 2, outcome: "transcribed", text: "Hello again.",
      sentences: [{ ...SENTENCES[0]!, text: "Hello again." }], model: "universal-3-5-pro", participants: ["Carol"] });
    expect(stored(sqlite, "rec-once").title).toBe("Oct 9 · AssemblyAI Universal-2 · Alice Chen");
  });

  test("a note created without the marker keeps its title through a commit", async () => {
    const { tcw, sqlite } = fakeTcw();
    await ensureSchema(tcw);
    await createPastedTranscriptRow(tcw, "pasted-kept", "Pasted notes", new Date(STARTED).toISOString());
    await commitVoiceNoteTranscript(tcw, "pasted-kept", { rev: 1, outcome: "transcribed", text: "Hello.", sentences: SENTENCES,
      model: "universal-2", participants: ["Alice Chen"] });
    expect(stored(sqlite, "pasted-kept").title).toBe("Pasted notes");
  });

  test("a note whose title was changed before the commit keeps the changed title", async () => {
    const { tcw, sqlite } = fakeTcw();
    await ensureSchema(tcw);
    await createVoiceNoteRow(tcw, recording("rec-edited"), DEFAULT_TITLE);
    // No app code writes titles yet; a direct write stands in for an edit that leaves the marker in place.
    sqlite.run("UPDATE connector_meeting SET title = ? WHERE source_id = ?", ["Board prep", "rec-edited"]);
    await commitVoiceNoteTranscript(tcw, "rec-edited", { rev: 1, outcome: "transcribed", text: "Hello.", sentences: SENTENCES,
      model: "universal-2", participants: ["Alice Chen"] });
    expect(stored(sqlite, "rec-edited").title).toBe("Board prep");
  });

  test("a note whose marker is false keeps its title through a commit", async () => {
    const { tcw, sqlite } = fakeTcw();
    await ensureSchema(tcw);
    await createVoiceNoteRow(tcw, recording("rec-unmarked"), DEFAULT_TITLE);
    sqlite.run("UPDATE connector_meeting SET metadata = json_set(metadata, '$.title_auto', json('false')) WHERE source_id = ?", ["rec-unmarked"]);
    await commitVoiceNoteTranscript(tcw, "rec-unmarked", { rev: 1, outcome: "transcribed", text: "Hello.", sentences: SENTENCES,
      model: "universal-2", participants: ["Alice Chen"] });
    expect(stored(sqlite, "rec-unmarked").title).toBe(DEFAULT_TITLE);
  });

  test("two commits of the same transcript at the same time set the title once", async () => {
    const { tcw, sqlite } = fakeTcw();
    await ensureSchema(tcw);
    await createVoiceNoteRow(tcw, recording("rec-race"), DEFAULT_TITLE);
    sqlite.exec("CREATE TABLE title_writes (n INTEGER NOT NULL); CREATE TRIGGER count_title_writes AFTER UPDATE OF title ON connector_meeting BEGIN INSERT INTO title_writes VALUES (1); END;");
    const transcript = { rev: 1, outcome: "transcribed" as const, text: "Hello.", sentences: SENTENCES,
      model: "universal-2", participants: ["Alice Chen"] };
    await Promise.all([commitVoiceNoteTranscript(tcw, "rec-race", transcript), commitVoiceNoteTranscript(tcw, "rec-race", transcript)]);
    expect(stored(sqlite, "rec-race").title).toBe("Oct 9 · AssemblyAI Universal-2 · Alice Chen");
    expect(sqlite.query("SELECT COUNT(*) AS n FROM title_writes").get()).toEqual({ n: 1 });
  });
});
