import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_SQL_DB_NAME, ensureSchema, transcriptKvKey } from "../connectors/connectorStore";
import { SQL_MEETING_METADATA_QUERY } from "../meetingChat/corpus";
import { legacyTranscriptWinner, readTranscriptCommit, voiceNoteTranscriptLocator } from "./voiceNoteCommits";
import { commitVoiceNoteTranscript, createVoiceNoteRow, ensureVoiceNoteIdentity, patchVoiceNoteAudio,
  reconcileDuplicates, sweepArchived, transcriptHash, transcriptRevKvKey } from "./voiceNoteRows";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes } from "./nativeVoiceNotes";
import { createVoiceNotePipeline, VoiceNoteSaveDeferred } from "./voiceNotePipeline";
import { handoffBeforeCredentialClear } from "./accountHandoff";
import { advanceAccountGeneration, currentAccountGeneration } from "./accountContext";
import { runOnSpaceLane } from "../spaceWriteLane";
import { associateLegacyNotes, markLegacyOwnerUnknown } from "./legacyMigration";

let count = 0;
function space() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = `did:test:t18-${++count}`;
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
  return { tcw: { did, spaceId: did, sql, kv } as unknown as TinyCloudWeb, sqlite, values };
}
function insert(sqlite: Database, id: string, sourceId: string, metadata: Record<string, unknown> = {}, source = "exo-voice-note") {
  sqlite.prepare(`INSERT INTO connector_meeting (id, source, source_id, title, started_at, duration_secs,
    participants, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 2, '[]', ?, ?, ?)`).run(
    id, source, sourceId, id, "2026-01-01T00:00:00.000Z", JSON.stringify(metadata), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}
function row(sqlite: Database, id: string) {
  const r = sqlite.query("SELECT metadata, updated_at FROM connector_meeting WHERE id = ?").get(id) as { metadata: string; updated_at: string };
  return { metadata: JSON.parse(r.metadata) as Record<string, unknown>, updatedAt: r.updated_at };
}
const sentence = (text: string) => [{ index: 0, speaker_name: "You", text, start_time: 0, end_time: 1 }];

describe("voice-note identity and transcript authority", () => {
  test("a reused SDK object checks identity again for a different account space", async () => {
    const { tcw } = space();
    const originalDb = tcw.sql.db.bind(tcw.sql);
    let tableCreates = 0;
    tcw.sql.db = ((name: string) => ({ ...originalDb(name), execute: async (statement: string, params: unknown[] = []) => {
      if (statement.startsWith("CREATE TABLE IF NOT EXISTS voice_note_transcript")) tableCreates++;
      return originalDb(name).execute(statement, params as never[]);
    } })) as typeof tcw.sql.db;
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    expect(tableCreates).toBe(1);
    Object.assign(tcw, { did: "did:test:other", spaceId: "did:test:other" });
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    expect(tableCreates).toBe(2);
  });
  test("an old random-id insert before deterministic create resolves to the old live row", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw);
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    insert(sqlite, "old-random-id", "rec");
    const row = await createVoiceNoteRow(tcw, { id: "rec", startedAt: 0, durationMs: 1000,
      mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Voice note");
    expect(row.id).toBe("old-random-id");
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source_id = 'rec'").all()).toHaveLength(1);
  });

  test("authorization is sign-in-again, while persistent constraints block after three rounds", async () => {
    const a = space();
    await ensureSchema(a.tcw);
    const aDb = a.tcw.sql.db.bind(a.tcw.sql);
    let authAttempts = 0;
    a.tcw.sql.db = ((name: string) => ({ ...aDb(name), execute: async (statement: string, params: unknown[] = []) => {
      if (statement.includes("voice_note_transcript")) {
        authAttempts++;
        return { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "schema required", meta: { status: 403 } } };
      }
      return aDb(name).execute(statement, params as never[]);
    } })) as typeof a.tcw.sql.db;
    expect((await ensureVoiceNoteIdentity(a.tcw)).status).toBe("needs_authorization");
    expect(authAttempts).toBe(1);

    const b = space();
    await ensureSchema(b.tcw);
    const bDb = b.tcw.sql.db.bind(b.tcw.sql);
    let constraints = 0;
    b.tcw.sql.db = ((name: string) => ({ ...bDb(name), execute: async (statement: string, params: unknown[] = []) => {
      if (statement.includes("CREATE UNIQUE INDEX")) {
        constraints++;
        return { ok: false, error: { code: "SQL_ERROR", message: "UNIQUE constraint failed" } };
      }
      return bDb(name).execute(statement, params as never[]);
    } })) as typeof b.tcw.sql.db;
    expect((await ensureVoiceNoteIdentity(b.tcw)).status).toBe("blocked");
    expect(constraints).toBe(3);
  });
  test("a full space leaves the note local with a specific identity state", async () => {
    const { tcw } = space();
    await ensureSchema(tcw);
    const originalDb = tcw.sql.db.bind(tcw.sql);
    tcw.sql.db = ((name: string) => ({ ...originalDb(name), execute: async (statement: string, params: unknown[] = []) =>
      statement.includes("CREATE TABLE IF NOT EXISTS voice_note_transcript")
        ? { ok: false, error: { code: "NETWORK_ERROR", message: "Storage quota exceeded. Used: 1048576. Limit: 1048576.",
          meta: { status: 402 } } }
        : originalDb(name).execute(statement, params as never[]),
    })) as typeof tcw.sql.db;
    expect(await ensureVoiceNoteIdentity(tcw)).toMatchObject({ status: "storage_full",
      reason: expect.stringContaining("storage is full") });
  });

  test("archives existing duplicates, keeps one live row and rejects late random-id inserts", async () => {
    const { tcw, sqlite } = space();
    expect((await ensureSchema(tcw)).ok).toBe(true);
    insert(sqlite, "b", "rec"); insert(sqlite, "a", "rec");
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source = 'exo-voice-note'").all()).toEqual([{ id: "a" }]);
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source = 'exo-voice-note-dup'").all()).toEqual([{ id: "b" }]);
    expect(() => insert(sqlite, "late", "rec")).toThrow();
  });
  test("two reconcilers leave a live keeper and preserve every archived sibling", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw);
    for (const id of ["c", "b", "a"]) insert(sqlite, id, "rec", { note: id });
    await Promise.all([reconcileDuplicates(tcw), reconcileDuplicates(tcw)]);
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source = 'exo-voice-note'").all()).toEqual([{ id: "a" }]);
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source = 'exo-voice-note-dup' ORDER BY id").all())
      .toEqual([{ id: "b" }, { id: "c" }]);
    expect(row(sqlite, "b").metadata.note).toBe("b");
  });
  test("a legacy write to the keeper between sweep group reads keeps the newer transcript", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw);
    insert(sqlite, "a", "rec"); insert(sqlite, "b", "rec");
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    sqlite.prepare("UPDATE connector_meeting SET metadata = ?, updated_at = 't3' WHERE id = 'b'").run(JSON.stringify({
      transcription_outcome: "transcribed", transcript_text: "T3 words", transcribed_at: "2026-03-01T00:00:00.000Z",
    }));
    const originalDb = tcw.sql.db.bind(tcw.sql);
    let groupReads = 0;
    tcw.sql.db = ((name: string) => ({ ...originalDb(name), query: async (statement: string, params: unknown[] = []) => {
      if (statement.includes("SELECT id, source, metadata, updated_at") && ++groupReads === 2) {
        sqlite.prepare("UPDATE connector_meeting SET metadata = ?, updated_at = 't9' WHERE id = 'a'").run(JSON.stringify({
          transcription_outcome: "transcribed", transcript_text: "T9 newest words", transcribed_at: "2026-09-01T00:00:00.000Z",
        }));
      }
      return originalDb(name).query(statement, params as never[]);
    } })) as typeof tcw.sql.db;
    await sweepArchived(tcw);
    expect(row(sqlite, "a").metadata.transcript_text).toBe("T9 newest words");
  });
  test("immutable bodies, CAS order, and commit survive old row and fixed-key writes", async () => {
    const { tcw, sqlite, values } = space();
    await ensureSchema(tcw); insert(sqlite, "vn-rec", "rec");
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    const first = await commitVoiceNoteTranscript(tcw, "rec", { rev: 2, outcome: "transcribed", text: "First", sentences: sentence("First") });
    await commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "no_speech", text: null, sentences: [] });
    const conflict = await commitVoiceNoteTranscript(tcw, "rec", { rev: 2, outcome: "transcribed", text: "Other", sentences: sentence("Other") });
    const winner = first.hash > conflict.hash ? first : conflict;
    expect((await readTranscriptCommit(tcw, "rec"))?.hash).toBe(winner.hash);
    sqlite.prepare("UPDATE connector_meeting SET metadata = ? WHERE id = 'vn-rec'").run(JSON.stringify({ transcription_outcome: "no_speech" }));
    values.set(transcriptKvKey("exo-voice-note", "rec"), JSON.stringify(sentence("Stale")));
    expect((await voiceNoteTranscriptLocator(tcw, "rec")).bodyKey).toBe(winner.bodyKey);
    expect((await readTranscriptCommit(tcw, "rec"))?.outcome).toBe("transcribed");
    expect(values.get(winner.bodyKey)).toContain(winner.hash === first.hash ? "First" : "Other");
    const silent = await commitVoiceNoteTranscript(tcw, "rec", { rev: 3, outcome: "no_speech", text: null, sentences: [] });
    expect(silent.preview).toBeNull();
    expect((await voiceNoteTranscriptLocator(tcw, "rec")).outcome).toBe("no_speech");
  });
  test("a delayed old body PUT and a later audio patch cannot change a newer transcript", async () => {
    const { tcw, sqlite, values } = space();
    await ensureSchema(tcw); insert(sqlite, "vn-rec", "rec");
    await ensureVoiceNoteIdentity(tcw);
    const oldSentences = sentence("Old words");
    const oldKey = transcriptRevKvKey("exo-voice-note", "rec", await transcriptHash(oldSentences));
    const put = tcw.kv.put.bind(tcw.kv);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atPut = new Promise<void>((resolve) => { entered = resolve; });
    tcw.kv.put = (async (key: string, value: unknown, opts: unknown) => {
      if (key === oldKey) { entered(); await gate; }
      return put(key, value as never, opts as never);
    }) as typeof tcw.kv.put;
    const old = commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "transcribed", text: "Old words", sentences: oldSentences });
    await atPut;
    const newer = commitVoiceNoteTranscript(tcw, "rec", { rev: 2, outcome: "transcribed", text: "New words", sentences: sentence("New words") });
    release();
    await Promise.all([old, newer]);
    const note = { id: "rec", startedAt: 0, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4,
      silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
    await patchVoiceNoteAudio(tcw, note, "android", { base: "audio-base", mimeType: "audio/mp4", size: 4, parts: 1 });
    const commit = await readTranscriptCommit(tcw, "rec");
    expect(commit?.rev).toBe(2);
    expect(values.get(commit!.bodyKey)).toContain("New words");
    expect(row(sqlite, "vn-rec").metadata.audio_kv_key).toBe("audio-base");
  });
  test("a crash after immutable body publication leaves an orphan that retry can commit", async () => {
    const { tcw, sqlite, values } = space();
    await ensureSchema(tcw); insert(sqlite, "vn-rec", "rec");
    await ensureVoiceNoteIdentity(tcw);
    const db = tcw.sql.db.bind(tcw.sql);
    let failOnce = true;
    tcw.sql.db = ((name: string) => ({ ...db(name), execute: async (statement: string, params: unknown[] = []) => {
      if (failOnce && statement.includes("INSERT INTO voice_note_transcript")) {
        failOnce = false;
        throw new Error("process died after body PUT");
      }
      return db(name).execute(statement, params as never[]);
    } })) as typeof tcw.sql.db;
    const sentences = sentence("Recovered words");
    await expect(commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "transcribed",
      text: "Recovered words", sentences })).rejects.toThrow("process died");
    expect(await readTranscriptCommit(tcw, "rec")).toBeNull();
    const key = transcriptRevKvKey("exo-voice-note", "rec", await transcriptHash(sentences));
    expect(values.get(key)).toContain("Recovered words");
    const committed = await commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "transcribed",
      text: "Recovered words", sentences });
    expect(committed.bodyKey).toBe(key);
  });
  test("late archived outcomes use one version rule before and after a sweep", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw);
    insert(sqlite, "a", "rec"); insert(sqlite, "b", "rec"); insert(sqlite, "c", "rec");
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    const update = (id: string, outcome: string, text: string | null, at: string) => sqlite.prepare(
      "UPDATE connector_meeting SET metadata = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify({ transcription_outcome: outcome, transcript_text: text, transcribed_at: at }), at, id);
    update("b", "no_speech", null, "2026-01-01T00:00:01.000Z");
    await sweepArchived(tcw);
    expect(row(sqlite, "a").metadata.transcription_outcome).toBe("no_speech");
    update("b", "transcribed", "Second", "2026-01-01T00:00:02.000Z");
    expect((await voiceNoteTranscriptLocator(tcw, "rec")).expectedText).toBe("Second");
    await sweepArchived(tcw);
    expect(row(sqlite, "a").metadata.transcript_text).toBe("Second");
    expect(row(sqlite, "b").metadata.merged_at).toBe(row(sqlite, "b").updatedAt);
    update("c", "transcribed", "Third", "2026-01-01T00:00:03.000Z");
    update("a", "no_speech", null, "2026-01-01T00:00:00.000Z");
    expect((await voiceNoteTranscriptLocator(tcw, "rec")).expectedText).toBe("Third");
    await sweepArchived(tcw);
    expect(row(sqlite, "a").metadata.transcript_text).toBe("Third");
    update("b", "transcribed", "Tie B", "2026-01-01T00:00:04.000Z");
    update("c", "transcribed", "Tie C", "2026-01-01T00:00:04.000Z");
    expect((await voiceNoteTranscriptLocator(tcw, "rec")).expectedText).toBe("Tie B");
    await sweepArchived(tcw);
    expect(row(sqlite, "a").metadata.transcript_text).toBe("Tie B");
    const fixture = ["a", "b", "c"].map((id) => ({ id, metadata: row(sqlite, id).metadata }));
    const ts = legacyTranscriptWinner(fixture)?.id;
    const sqlWinner = sqlite.query(`SELECT g.id FROM connector_meeting g WHERE g.source_id = 'rec'
      AND g.source IN ('exo-voice-note', 'exo-voice-note-dup') AND json_extract(g.metadata, '$.transcription_outcome') IS NOT NULL
      ORDER BY COALESCE(json_extract(g.metadata, '$.transcribed_at'), '') DESC, g.id ASC LIMIT 1`).get() as { id: string };
    expect(ts).toBe(sqlWinner.id);
    expect((sqlite.query(SQL_MEETING_METADATA_QUERY).all() as { source_id: string }[]).some((r) => r.source_id === "rec")).toBe(true);
    await commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "no_speech", text: null, sentences: [] });
    expect((sqlite.query(SQL_MEETING_METADATA_QUERY).all() as { source_id: string }[]).some((r) => r.source_id === "rec")).toBe(false);
  });
});

test("cancelAll stops an upload at its next KV checkpoint and quiescent waits", async () => {
  const original = VoiceNotes;
  const { tcw, values } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    const { id } = await fake.plugin.start();
    await fake.plugin.stop();
    const pipeline = createVoiceNotePipeline(tcw);
    let entered!: () => void;
    const atPart = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const put = tcw.kv.put.bind(tcw.kv);
    tcw.kv.put = (async (key: string, value: unknown, opts: unknown) => {
      if (key.includes("/audio/") && key.includes("/p/")) { entered(); await gate; }
      return put(key, value as never, opts as never);
    }) as typeof tcw.kv.put;
    const ctx = { did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() };
    const job = pipeline.process(ctx, id);
    await atPart;
    pipeline.cancelAll();
    expect(await pipeline.quiescent(0)).toBe(false);
    // Re-arming for a later session cannot turn this old job into an error receipt.
    pipeline.resume();
    release();
    await expect(job).rejects.toBeInstanceOf(VoiceNoteSaveDeferred);
    expect(await pipeline.quiescent(100)).toBe(true);
    expect([...values.keys()].some((key) => key.endsWith("/manifest"))).toBe(false);
  } finally {
    __setVoiceNotesForTests(original, { available: null });
  }
});

test("Stop during the OpenKey wait after handoff cannot upload to the old account", async () => {
  const previous = VoiceNotes;
  const { tcw, values } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "private-cloud", identifySpeakers: false });
    const live = await fake.plugin.start();
    const pipeline = createVoiceNotePipeline(tcw);
    expect((await handoffBeforeCredentialClear(tcw.did, pipeline)).ok).toBe(true);
    const stopped = await fake.plugin.stop();
    expect(stopped.id).toBe(live.id);
    expect(stopped.owner).toBe(tcw.did);
    expect(pipeline.isAccepting()).toBe(false);
    await expect(pipeline.process({ did: tcw.did, spaceId: tcw.spaceId,
      generation: currentAccountGeneration() }, stopped.id)).rejects.toThrow("suspended");
    expect(values.size).toBe(0);
    const current = await fake.plugin.getCaptureDefaults();
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: current.transitionGen + 1,
      transcriber: "on-device", identifySpeakers: false });
    pipeline.resume();
    await pipeline.reconcileAll({ did: tcw.did, spaceId: tcw.spaceId,
      generation: advanceAccountGeneration() });
    expect((await fake.plugin.listPending()).recordings.find((note) => note.id === stopped.id)?.ledger?.audio.state).toBe("saved");
    expect(values.size).toBeGreaterThan(0);
  } finally { __setVoiceNotesForTests(previous, { available: null }); }
});

test("another account's retained notes do not delay a fresh Stop with a space preflight", async () => {
  const previous = VoiceNotes;
  const { tcw, sqlite } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: "did:test:previous", transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    await fake.plugin.start();
    const old = await fake.plugin.stop();
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 2,
      transcriber: "on-device", identifySpeakers: false });
    const pipeline = createVoiceNotePipeline(tcw);
    const ctx = { did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() };
    await pipeline.reconcileAll(ctx);
    expect(sqlite.query("SELECT name FROM sqlite_schema WHERE name = 'voice_note_transcript'").all()).toEqual([]);
    await fake.plugin.start();
    const fresh = await fake.plugin.stop();
    await pipeline.process(ctx, fresh.id);
    const notes = (await fake.plugin.listPending()).recordings;
    expect(notes.find((note) => note.id === old.id)?.ledger?.audio.state).toBe("pending");
    expect(notes.find((note) => note.id === fresh.id)?.ledger?.audio.state).toBe("saved");
  } finally { __setVoiceNotesForTests(previous, { available: null }); }
});

test("a user-choice claimed legacy note uploads once and keeps its owner", async () => {
  const original = VoiceNotes;
  const { tcw, sqlite } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    const legacy = { id: "chosen-legacy", startedAt: 1, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4,
      silencedMs: 0, silencedEvents: 0, noSignalMs: 0, version: 1 as const, legacyImport: true };
    fake.controls.commitLegacy(legacy);
    await fake.plugin.claim({ id: legacy.id, did: tcw.did, evidence: "user_choice" });
    const owned = (await fake.plugin.listPending()).recordings[0]!;
    expect(markLegacyOwnerUnknown([owned])[0]?.owner).toBe(tcw.did);
    const pipeline = createVoiceNotePipeline(tcw);
    const ctx = { did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() };
    await pipeline.process(ctx, legacy.id);
    await pipeline.process(ctx, legacy.id);
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source_id = 'chosen-legacy'").all())
      .toEqual([{ id: "vn-chosen-legacy" }]);
    expect((await fake.plugin.listPending()).recordings[0]?.ledger?.audio.state).toBe("saved");
  } finally { __setVoiceNotesForTests(original, { available: null }); }
});

test("a legacy owner mismatch is reported per note and another owned note still reconciles", async () => {
  const original = VoiceNotes;
  const { tcw, sqlite } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    const legacy = { id: "belongs-to-a", startedAt: 1, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 4,
      silencedMs: 0, silencedEvents: 0, noSignalMs: 0, version: 1 as const, legacyImport: true };
    fake.controls.commitLegacy(legacy);
    const stale = (await fake.plugin.listPending()).recordings[0]!;
    await fake.plugin.claim({ id: legacy.id, did: "did:other", evidence: "user_choice" });
    await ensureSchema(tcw);
    insert(sqlite, "other-row", legacy.id);
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args) => { warnings.push(args); };
    try { expect(await associateLegacyNotes(tcw, tcw.did, [stale])).toEqual([]); }
    finally { console.warn = warn; }
    expect(warnings.some(([message]) => String(message).includes("another account"))).toBe(true);
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    const { id } = await fake.plugin.start();
    await fake.plugin.stop();
    const realList = fake.plugin.listPending.bind(fake.plugin);
    let staleOnce = true;
    fake.plugin.listPending = async () => {
      const result = await realList();
      if (!staleOnce) return result;
      staleOnce = false;
      return { recordings: result.recordings.map((note) => note.id === legacy.id ? stale : note) };
    };
    const pipeline = createVoiceNotePipeline(tcw);
    await pipeline.reconcileAll({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() });
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source_id = ?").all(id)).toEqual([{ id: `vn-${id}` }]);
    expect((await fake.plugin.listPending()).recordings.find((note) => note.id === legacy.id)?.owner).toBe("did:other");
  } finally { __setVoiceNotesForTests(original, { available: null }); }
});

test("cancelAll prevents queued identity SQL from reaching the space", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  await ensureSchema(tcw);
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const atLane = new Promise<void>((resolve) => { entered = resolve; });
  const occupying = runOnSpaceLane(async () => { entered(); await blocked; });
  try {
    await atLane;
    let calls = 0;
    const originalDb = tcw.sql.db.bind(tcw.sql);
    tcw.sql.db = ((name: string) => ({ ...originalDb(name),
      query: async (statement: string, params: unknown[] = []) => { calls++; return originalDb(name).query(statement, params as never[]); },
      execute: async (statement: string, params: unknown[] = []) => { calls++; return originalDb(name).execute(statement, params as never[]); },
    })) as typeof tcw.sql.db;
    const pipeline = createVoiceNotePipeline(tcw);
    const ctx = { did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() };
    const job = pipeline.process(ctx, "missing");
    await Promise.resolve();
    pipeline.cancelAll();
    release();
    await expect(job).rejects.toThrow();
    await occupying;
    expect(calls).toBe(0);
  } finally { release(); __setVoiceNotesForTests(original, { available: null }); }
});

test("a stale checkpoint prevents queued create and archive sweep SQL", async () => {
  const { tcw } = space();
  await ensureSchema(tcw);
  expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const atLane = new Promise<void>((resolve) => { entered = resolve; });
  const occupying = runOnSpaceLane(async () => { entered(); await blocked; });
  try {
    await atLane;
    let calls = 0;
    const originalDb = tcw.sql.db.bind(tcw.sql);
    tcw.sql.db = ((name: string) => ({ ...originalDb(name),
      query: async (statement: string, params: unknown[] = []) => { calls++; return originalDb(name).query(statement, params as never[]); },
      execute: async (statement: string, params: unknown[] = []) => { calls++; return originalDb(name).execute(statement, params as never[]); },
    })) as typeof tcw.sql.db;
    let current = true;
    const checkpoint = () => { if (!current) throw new Error("cancelled"); };
    const create = createVoiceNoteRow(tcw, { id: "queued", startedAt: 0, durationMs: 1000,
      mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Queued", checkpoint);
    const sweep = sweepArchived(tcw, checkpoint);
    await Promise.resolve();
    current = false;
    release();
    expect((await Promise.allSettled([create, sweep])).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await occupying;
    expect(calls).toBe(0);
  } finally { release(); }
});

test("a cancelled schema caller does not cancel another caller's bootstrap", async () => {
  const { tcw } = space();
  const originalDb = tcw.sql.db.bind(tcw.sql);
  let entered!: () => void;
  const atProbe = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const probeGate = new Promise<void>((resolve) => { release = resolve; });
  tcw.sql.db = ((name: string) => ({ ...originalDb(name), query: async (statement: string, params: unknown[] = []) => {
    if (statement.includes("FROM sqlite_master")) { entered(); await probeGate; }
    return originalDb(name).query(statement, params as never[]);
  } })) as typeof tcw.sql.db;
  let cancelled = false;
  const first = ensureSchema(tcw, () => { if (cancelled) throw new Error("first caller cancelled"); });
  await atProbe;
  const second = ensureSchema(tcw);
  cancelled = true;
  release();
  await expect(first).rejects.toThrow("first caller cancelled");
  expect((await second).ok).toBe(true);
});

test("a cancelled identity caller does not cancel another caller's gate", async () => {
  const { tcw } = space();
  await ensureSchema(tcw);
  const originalDb = tcw.sql.db.bind(tcw.sql);
  let entered!: () => void;
  const atDDL = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const ddlGate = new Promise<void>((resolve) => { release = resolve; });
  tcw.sql.db = ((name: string) => ({ ...originalDb(name), execute: async (statement: string, params: unknown[] = []) => {
    if (statement.startsWith("CREATE TABLE IF NOT EXISTS voice_note_transcript")) { entered(); await ddlGate; }
    return originalDb(name).execute(statement, params as never[]);
  } })) as typeof tcw.sql.db;
  let cancelled = false;
  const first = ensureVoiceNoteIdentity(tcw, () => { if (cancelled) throw new Error("first caller cancelled"); });
  await atDDL;
  const second = ensureVoiceNoteIdentity(tcw);
  cancelled = true;
  release();
  await expect(first).rejects.toThrow("first caller cancelled");
  expect((await second).status).toBe("established");
});

test("a malformed old discard marker stays available for repair while owned uploads continue", async () => {
  const original = VoiceNotes;
  const storage = globalThis.localStorage;
  const marker = new Map([["exo.voiceNotes.discarded", "{broken"]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => marker.get(key) ?? null,
    setItem: (key: string, value: string) => void marker.set(key, value),
    removeItem: (key: string) => void marker.delete(key),
  } });
  const { tcw, sqlite } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    const { id } = await fake.plugin.start();
    await fake.plugin.stop();
    const pipeline = createVoiceNotePipeline(tcw);
    await expect(pipeline.reconcileAll({ did: tcw.did, spaceId: tcw.spaceId,
      generation: currentAccountGeneration() })).rejects.toMatchObject({ code: "discard_migration_failed" });
    expect(marker.get("exo.voiceNotes.discarded")).toBe("{broken");
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source_id = ?").all(id)).toEqual([{ id: `vn-${id}` }]);
  } finally {
    __setVoiceNotesForTests(original, { available: null });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  }
});

test("a discarded note cannot upload when discard migration cannot delete its audio", async () => {
  const original = VoiceNotes;
  const storage = globalThis.localStorage;
  const marker = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => marker.get(key) ?? null,
    setItem: (key: string, value: string) => void marker.set(key, value),
    removeItem: (key: string) => void marker.delete(key),
  } });
  const { tcw, sqlite } = space();
  await ensureSchema(tcw);
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    const { id } = await fake.plugin.start();
    await fake.plugin.stop();
    const { id: keptId } = await fake.plugin.start();
    await fake.plugin.stop();
    marker.set("exo.voiceNotes.discarded", JSON.stringify([id]));
    fake.plugin.deleteAudio = async () => { throw Object.assign(new Error("io"), { code: "io_error" }); };
    await expect(createVoiceNotePipeline(tcw).reconcileAll({ did: tcw.did, spaceId: tcw.spaceId,
      generation: currentAccountGeneration() })).rejects.toMatchObject({ code: "discard_migration_failed" });
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source_id = ?").all(id)).toEqual([]);
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source_id = ?").all(keptId))
      .toEqual([{ id: `vn-${keptId}` }]);
    expect(marker.get("exo.voiceNotes.discarded")).toBe(JSON.stringify([id]));
  } finally {
    __setVoiceNotesForTests(original, { available: null });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  }
});
