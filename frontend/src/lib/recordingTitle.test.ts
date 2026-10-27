import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { __resetStorageStatusForTests } from "@/lib/storageStatus";
import { CONNECTORS_SQL_DB_NAME, ensureSchema, upsertMeeting, type NormalizedMeeting } from "./connectors/connectorStore";
import { commitVoiceNoteTranscript, createVoiceNoteRow } from "./voiceNotes/voiceNoteRows";
import { subscribeSpaceLane } from "./spaceWriteLane";
import { readUserTitledIds, renameRecording } from "./recordingTitle";
import { hasUserTitle, keepUserTitle, normalizeRecordingTitle } from "./recordingTitleMeta";

afterEach(() => { __resetStorageStatusForTests(); });

const STARTED = new Date(2026, 9, 9, 10, 30).getTime();
const DEFAULT_TITLE = "Voice note · Oct 9";
const SENTENCES = [{ index: 0, speaker_name: "You", text: "Hello.", start_time: 0, end_time: 5 }];
const AUTO = "Oct 9 · AssemblyAI Universal-2 · Alice Chen";

let count = 0;
function fakeTcw() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = `did:test:rename-${++count}`;
  const run = (fn: () => unknown) => {
    try { return { ok: true, data: fn() }; } catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
  };
  const sql = { db: (name: string) => {
    expect(name).toBe(CONNECTORS_SQL_DB_NAME);
    return {
      async query(statement: string, params: unknown[] = []) {
        return run(() => ({ rows: sqlite.prepare(statement).all(...params as never[]).map((r) => Object.values(r as object)) }));
      },
      async execute(statement: string, params: unknown[] = []) {
        return run(() => ({ changes: sqlite.prepare(statement).run(...params as never[]).changes }));
      },
    };
  } };
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
  return { tcw: { did, spaceId: did, sql, kv } as unknown as TinyCloudWeb, sqlite };
}

const recording = (id: string) => ({ id, startedAt: STARTED, durationMs: 1_000, mimeType: "audio/mp4", sizeBytes: 4,
  silencedMs: 0, silencedEvents: 0, noSignalMs: 0 });
const stored = (sqlite: Database, sourceId: string) => {
  const r = sqlite.query("SELECT id, title, metadata FROM connector_meeting WHERE source_id = ?").get(sourceId) as { id: string; title: string; metadata: string };
  return { id: r.id, title: r.title, metadata: JSON.parse(r.metadata) as Record<string, unknown> };
};
const commit = (tcw: TinyCloudWeb, id: string, rev: number, names: string[]) =>
  commitVoiceNoteTranscript(tcw, id, { rev, outcome: "transcribed", text: `Hello ${rev}.`, sentences: [{ ...SENTENCES[0]!, text: `Hello ${rev}.` }],
    model: "universal-2", participants: names });

async function voiceNote(sourceId: string) {
  const f = fakeTcw();
  await ensureSchema(f.tcw);
  await createVoiceNoteRow(f.tcw, recording(sourceId), DEFAULT_TITLE);
  return { ...f, rowId: stored(f.sqlite, sourceId).id };
}

describe("normalizeRecordingTitle", () => {
  test("trims, collapses whitespace and control characters, and caps the length", () => {
    expect(normalizeRecordingTitle("  Q4 \n planning\tcall  ")).toBe("Q4 planning call");
    expect(normalizeRecordingTitle("   \n\t ")).toBe("");
    expect([...normalizeRecordingTitle("x".repeat(500))]).toHaveLength(120);
  });
});

describe("renaming a recording", () => {
  test("is stored with the row: the title column, a user marker and the title it replaced", async () => {
    const { tcw, sqlite, rowId } = await voiceNote("rec-a");
    expect(await renameRecording(tcw, rowId, "  Q4 planning call ")).toEqual({ ok: true, title: "Q4 planning call" });
    const note = stored(sqlite, "rec-a");
    expect(note.title).toBe("Q4 planning call");
    expect(note.metadata.title_user).toBe(true);
    expect(note.metadata.title_auto_value).toBe(DEFAULT_TITLE);
    expect(hasUserTitle(note.metadata)).toBe(true);
  });

  test("a name set before the transcript lands is kept by the commit, even when it equals the insert-time title", async () => {
    const { tcw, sqlite, rowId } = await voiceNote("rec-b");
    await renameRecording(tcw, rowId, "Venue call");
    await commit(tcw, "rec-b", 1, ["Alice Chen"]);
    expect(stored(sqlite, "rec-b").title).toBe("Venue call");

    const same = await voiceNote("rec-c");
    await renameRecording(same.tcw, same.rowId, DEFAULT_TITLE);
    await commit(same.tcw, "rec-c", 1, ["Alice Chen"]);
    expect(stored(same.sqlite, "rec-c").title).toBe(DEFAULT_TITLE);
  });

  test("a name set after the first commit survives a re-transcribe commit", async () => {
    const { tcw, sqlite, rowId } = await voiceNote("rec-d");
    await commit(tcw, "rec-d", 1, ["Alice Chen"]);
    expect(stored(sqlite, "rec-d").title).toBe(AUTO);
    await renameRecording(tcw, rowId, "Venue call");
    await commit(tcw, "rec-d", 2, ["Carol"]);
    const note = stored(sqlite, "rec-d");
    expect(note.title).toBe("Venue call");
    expect(note.metadata.title_auto_value).toBe(AUTO);
  });

  test("clearing the name returns to the automatic title, recomputed from the transcript's date and participants", async () => {
    const { tcw, sqlite, rowId } = await voiceNote("rec-e");
    await commit(tcw, "rec-e", 1, ["Alice Chen"]);
    await renameRecording(tcw, rowId, "Venue call");
    expect(await renameRecording(tcw, rowId, "   ")).toEqual({ ok: true, title: AUTO });
    const note = stored(sqlite, "rec-e");
    expect(note.title).toBe(AUTO);
    expect(note.metadata).not.toHaveProperty("title_user");
    expect(note.metadata).not.toHaveProperty("title_auto_value");
  });

  test("clearing before the transcript lands lets the commit name the note", async () => {
    const { tcw, sqlite, rowId } = await voiceNote("rec-f");
    await renameRecording(tcw, rowId, "Venue call");
    await renameRecording(tcw, rowId, "");
    expect(stored(sqlite, "rec-f").title).toBe(DEFAULT_TITLE);
    await commit(tcw, "rec-f", 1, ["Alice Chen"]);
    expect(stored(sqlite, "rec-f").title).toBe(AUTO);
  });

  test("an empty name on a recording with no name of its own changes nothing", async () => {
    const { tcw, sqlite, rowId } = await voiceNote("rec-g");
    const before = sqlite.query("SELECT updated_at FROM connector_meeting WHERE id = ?").get(rowId);
    await renameRecording(tcw, rowId, "");
    expect(sqlite.query("SELECT updated_at FROM connector_meeting WHERE id = ?").get(rowId)).toEqual(before);
  });

  test("a second rename keeps the original automatic title", async () => {
    const { tcw, sqlite, rowId } = await voiceNote("rec-h");
    await renameRecording(tcw, rowId, "One");
    await renameRecording(tcw, rowId, "Two");
    const note = stored(sqlite, "rec-h");
    expect(note.title).toBe("Two");
    expect(note.metadata.title_auto_value).toBe(DEFAULT_TITLE);
  });

  test("the rows with a name of their own can be listed, and clearing removes one", async () => {
    const a = await voiceNote("rec-i");
    await createVoiceNoteRow(a.tcw, recording("rec-j"), DEFAULT_TITLE);
    await renameRecording(a.tcw, a.rowId, "Mine");
    expect([...await readUserTitledIds(a.tcw)]).toEqual([a.rowId]);
    await renameRecording(a.tcw, a.rowId, "");
    expect((await readUserTitledIds(a.tcw)).size).toBe(0);
  });

  test("the read and the write both run on the space write lane", async () => {
    const { tcw, rowId } = await voiceNote("rec-lane");
    let turns = 0;
    const off = subscribeSpaceLane(() => { turns++; });
    await renameRecording(tcw, rowId, "On the lane");
    const renamed = turns;
    await readUserTitledIds(tcw);
    off();
    expect(renamed).toBeGreaterThanOrEqual(4);
    expect(turns).toBe(renamed);
  });

  test("a recording that is not in the space reports it", async () => {
    const { tcw } = fakeTcw();
    await ensureSchema(tcw);
    const result = await renameRecording(tcw, "vn-missing", "Name");
    expect(result.ok).toBe(false);
  });
});

describe("re-sync of a renamed meeting", () => {
  const meeting = (title: string): NormalizedMeeting => ({ id: "ff-1", source: "fireflies", sourceId: "ff-src", title,
    startedAt: "2026-08-17T09:00:00.000Z", durationSecs: 60, organizerEmail: null, participants: [], summaryOverview: null,
    summaryActionItems: null, keywords: null, meetingType: null, metadata: {} });

  test("keeps the user's title, tracks the provider's title for clearing, and clearing restores it", async () => {
    const { tcw, sqlite } = fakeTcw();
    await ensureSchema(tcw);
    await upsertMeeting(tcw, meeting("Weekly sync"), []);
    await renameRecording(tcw, "ff-1", "Atlas kickoff");
    await upsertMeeting(tcw, meeting("Weekly sync (renamed upstream)"), []);
    const note = stored(sqlite, "ff-src");
    expect(note.title).toBe("Atlas kickoff");
    expect(note.metadata.title_user).toBe(true);
    expect(note.metadata.title_auto_value).toBe("Weekly sync (renamed upstream)");
    await renameRecording(tcw, "ff-1", "");
    expect(stored(sqlite, "ff-src").title).toBe("Weekly sync (renamed upstream)");
  });

  test("an unrenamed meeting still follows the provider's title", async () => {
    const { tcw, sqlite } = fakeTcw();
    await ensureSchema(tcw);
    await upsertMeeting(tcw, meeting("Weekly sync"), []);
    await upsertMeeting(tcw, meeting("Weekly sync v2"), []);
    expect(stored(sqlite, "ff-src").title).toBe("Weekly sync v2");
  });
});

describe("keepUserTitle (combined meetings)", () => {
  test("a re-combine keeps the user's title and records the new automatic one", () => {
    const kept = keepUserTitle({ title: "Our name", metadata: { title_user: true, title_auto_value: "Old", merge: { n: 1 } } },
      { title: "New combined", metadata: { merge: { n: 2 } } });
    expect(kept).toEqual({ title: "Our name", metadata: { merge: { n: 2 }, title_user: true, title_auto_value: "New combined" } });
  });
  test("without a user title the incoming one applies", () => {
    const incoming = { title: "New combined", metadata: { merge: { n: 2 } } };
    expect(keepUserTitle({ title: "Old", metadata: {} }, incoming)).toBe(incoming);
  });
});
