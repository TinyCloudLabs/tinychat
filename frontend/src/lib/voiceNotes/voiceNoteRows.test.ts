import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { captureEvents } from "@/capture/captureEvents";
import { PendingVoiceNotesSaver, schedulePendingVoiceNotesRecovery } from "@/chat/PendingVoiceNotesSaver";
import { OnDeviceStt, __setOnDeviceSttForTests, type OnDeviceSttPlugin } from "./onDeviceStt";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_SQL_DB_NAME, ensureSchema, transcriptKvKey } from "../connectors/connectorStore";
import { readVoiceNoteTranscriptState, saveVoiceNote } from "./voiceNoteStore";
import { SQL_MEETING_METADATA_QUERY } from "../meetingChat/corpus";
import { legacyTranscriptWinner, readTranscriptCommit, voiceNoteTranscriptLocator } from "./voiceNoteCommits";
import { whisperLocalTranscript } from "./desktop/whisperTranscript";
import { commitVoiceNoteTranscript, createVoiceNoteRow, ensureVoiceNoteIdentity, patchVoiceNoteAudio,
  patchVoiceNoteTranscriptionFailure, reconcileDuplicates, resolveVoiceNoteRow, sweepArchived, transcriptHash, transcriptRevKvKey } from "./voiceNoteRows";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { NoteDetailView } from "@/capture/library/NoteDetailView";
import { hasPrivateCloudTimingProvenance, transcriptMarkdown, transcriptWithTimestamps } from "@/capture/library/transcriptSegments";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes } from "./nativeVoiceNotes";
import { syncOnDeviceTranscript } from "./onDeviceTranscriber";
import { createVoiceNotePipeline, VoiceNoteSaveDeferred, type VoiceNotePipeline } from "./voiceNotePipeline";
import { handoffBeforeCredentialClear } from "./accountHandoff";
import { advanceAccountGeneration, currentAccountGeneration } from "./accountContext";
import { runOnSpaceLane, spaceLaneSnapshot, subscribeSpaceLane } from "../spaceWriteLane";
import { setVoiceNoteSaveDeadlineForTests } from "./saveDeadline";
import { putPendingSaveState, readPendingSaveStates } from "./pendingSaveState";
import { reportStorageWriteSucceeded, trackStorageWrites } from "@/lib/storageStatus";
import { pendingStore, saveNoteForAccount } from "./recorderSaves";
import { associateLegacyNotes, markLegacyOwnerUnknown, migrateLegacyDiscardLedger } from "./legacyMigration";
import { loadNote, saveNote } from "./recordingNotes";
import { readRecordingNoteFromSpace, syncRecordingNote, VOICE_NOTE_SOURCE, voiceNoteAudioKvKey, voiceNoteMarkdownKvKey } from "./voiceNoteStore";

describe.serial("voice-note rows", () => {


test("a healthy long drain does not consume the next save's call deadline", async () => {
  let releaseDrain!: () => void;
  let enteredDrain!: () => void;
  const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
  const drainEntered = new Promise<void>((resolve) => { enteredDrain = resolve; });
  const drain = runOnSpaceLane(async () => { enteredDrain(); await drainGate; return "drained"; });
  await drainEntered;
  let saveStarted = false;
  const save = runOnSpaceLane(async () => { saveStarted = true; return "saved"; },
    { operation: "SQL execute: voice-note save after drain", timeoutMs: 20 });

  try {
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(saveStarted).toBe(false);
    releaseDrain();
    await expect(drain).resolves.toBe("drained");
    await expect(save).resolves.toBe("saved");
    expect(saveStarted).toBe(true);
  } finally { releaseDrain(); }
});
test("after one storage-full audio put, later notes in the pass still save rows and text; only their audio PUT is skipped", async () => {
  const original = VoiceNotes;
  const fake = createFakeVoiceNotes();
  const { tcw, values } = space();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const kv = tcw.kv;
  const put = kv.put.bind(kv);
  const audioPrefix = voiceNoteAudioKvKey("");
  const audioPutIds = new Set<string>();
  kv.put = (async (...args: Parameters<typeof put>) => {
    const [key] = args;
    if (key.startsWith(audioPrefix) && !key.endsWith("note.md")) {
      audioPutIds.add(key.slice(audioPrefix.length).split("/")[0]!);
      return { ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "Your TinyCloud storage is full" } } as Awaited<ReturnType<typeof put>>;
    }
    return put(...args);
  }) as typeof kv.put;
  const captureDefaults = (uploadAudio: boolean) => ({ accountDid: tcw.did, transitionGen: 1, transcriber: "on-device" as const,
    identifySpeakers: false, uploadAudio });
  const idsOf = async () => (await fake.plugin.listPending()).recordings.map((note) => note.id);
  const record = async (uploadAudio: boolean) => {
    await fake.plugin.setCaptureDefaults(captureDefaults(uploadAudio));
    await Bun.sleep(5);
    const before = new Set(await idsOf());
    await fake.plugin.start();
    await fake.plugin.stop();
    return (await idsOf()).find((id) => !before.has(id))!;
  };
  try {
    const first = await record(true);
    const second = await record(true);
    const local = await record(false);
    await createVoiceNotePipeline(tcw).reconcileAll({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() });
    // One audio probe per pass: only the first note's audio PUT reaches the space.
    expect([...audioPutIds]).toEqual([first]);
    // Every note in the pass still gets its row and transcript text, including the local-only one.
    for (const id of [first, second, local]) {
      expect(values.has(transcriptKvKey(VOICE_NOTE_SOURCE, id))).toBe(true);
      expect(await resolveVoiceNoteRow(tcw, id)).not.toBeNull();
    }
    // Local-only notes report audio as saved (nothing to upload); only the two upload notes may not be saved.
    const uploadStates = (await fake.plugin.listPending()).recordings.filter((note) => note.id !== local).map((note) => note.ledger?.audio.state);
    expect(uploadStates).toHaveLength(2);
    expect(uploadStates).not.toContain("saved");
  } finally {
    kv.put = put;
    reportStorageWriteSucceeded();
    __setVoiceNotesForTests(original, { available: null });
  }
});


test("a stalled background drain cannot delay a voice-note row request", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const drain = runOnSpaceLane(async () => { entered(); await gate; }, undefined, "background");
  await started;
  try {
    await expect(runOnSpaceLane(async () => "row saved", { operation: "voice-note row", timeoutMs: 20 }))
      .resolves.toBe("row saved");
  } finally { release(); await drain; }
});

test("a lane job that rejects without a reason rejects its caller", async () => {
  const result = await Promise.allSettled([runOnSpaceLane(() => Promise.reject(undefined))]);
  expect(result).toEqual([{ status: "rejected", reason: undefined }]);
});

test("space lane snapshot reports busy state and queued depth", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let notifications = 0;
  const unsubscribe = subscribeSpaceLane(() => { notifications++; });
  const first = runOnSpaceLane(async () => { entered(); await gate; });
  await started;
  const second = runOnSpaceLane(async () => undefined);
  expect(spaceLaneSnapshot()).toEqual({ busy: true, depth: 1 });
  release();
  await Promise.all([first, second]);
  expect(spaceLaneSnapshot()).toEqual({ busy: false, depth: 0 });
  expect(notifications).toBeGreaterThan(0);
  unsubscribe();
});

test("one save publishes note text while an audio part is stalled", async () => {
  const { tcw, values } = space();
  await ensureVoiceNoteIdentity(tcw);
  const id = `short-sync-${++count}`;
  await saveNote(id, "Text must arrive before audio");
  let calls = 0;
  const db = tcw.sql.db.bind(tcw.sql);
  tcw.sql.db = ((name: string) => {
    const handle = db(name);
    return { ...handle,
      query: async (...args: Parameters<typeof handle.query>) => { calls++; return handle.query(...args); },
      execute: async (...args: Parameters<typeof handle.execute>) => { calls++; return handle.execute(...args); },
    };
  }) as typeof tcw.sql.db;
  const put = tcw.kv.put.bind(tcw.kv);
  const get = tcw.kv.get.bind(tcw.kv);
  const list = tcw.kv.list.bind(tcw.kv);
  let releaseAudio!: () => void;
  let audioStarted!: () => void;
  const audioGate = new Promise<void>((resolve) => { releaseAudio = resolve; });
  const started = new Promise<void>((resolve) => { audioStarted = resolve; });
  tcw.kv.put = (async (...args: Parameters<typeof put>) => {
    calls++;
    if (args[0].includes("/p/")) { audioStarted(); await audioGate; }
    return put(...args);
  }) as typeof tcw.kv.put;
  tcw.kv.get = (async (...args: Parameters<typeof get>) => { calls++; return get(...args); }) as typeof tcw.kv.get;
  tcw.kv.list = (async (...args: Parameters<typeof list>) => { calls++; return list(...args); }) as typeof tcw.kv.list;
  const recording = { id, startedAt: Date.now(), durationMs: 52_000, mimeType: "audio/mp4", sizeBytes: 4,
    silencedMs: 0, silencedEvents: 0, noSignalMs: 0, version: 2 as const,
    source: "in_app" as const, options: { transcriber: "private-cloud" as const, identifySpeakers: false, uploadAudio: true } };
  const saving = saveVoiceNote(tcw, recording, { mimeType: "audio/mp4", size: 4,
    readPart: async () => new Uint8Array([1, 2, 3, 4]) }, "tauri");
  try {
    await started;
    for (let i = 0; i < 100 && !values.has(voiceNoteMarkdownKvKey(id)); i++) await Bun.sleep(1);
    expect(values.get(voiceNoteMarkdownKvKey(id))).toContain("Text must arrive before audio");
    expect(values.has(`${voiceNoteAudioKvKey(id)}/manifest`)).toBe(false);
    expect((await resolveVoiceNoteRow(tcw, id))?.metadata).toMatchObject({
      capture: { platform: "tauri", options: { transcriber: "private-cloud" } },
      note_kv_key: voiceNoteMarkdownKvKey(id),
    });
  } finally { releaseAudio(); }
  expect((await saving).ok).toBe(true);
  // Ten save requests plus the assertion's row read above. The old path
  // performed 12+ sequential requests in Sam's log.
  expect(calls).toBe(11);
});

test("one save overlaps short text and audio requests at fixed fixture latency", async () => {
  const { tcw } = space();
  await ensureVoiceNoteIdentity(tcw);
  const id = `timed-sync-${++count}`;
  await saveNote(id, "Timed fixture");
  let serialLatency = 0;
  const delay = async () => {
    const start = performance.now();
    await Bun.sleep(20);
    serialLatency += performance.now() - start;
  };
  let calls = 0;
  const db = tcw.sql.db.bind(tcw.sql);
  tcw.sql.db = ((name: string) => {
    const handle = db(name);
    return { ...handle,
      query: async (...args: Parameters<typeof handle.query>) => { calls++; await delay(); return handle.query(...args); },
      execute: async (...args: Parameters<typeof handle.execute>) => { calls++; await delay(); return handle.execute(...args); },
    };
  }) as typeof tcw.sql.db;
  const put = tcw.kv.put.bind(tcw.kv);
  const get = tcw.kv.get.bind(tcw.kv);
  const list = tcw.kv.list.bind(tcw.kv);
  tcw.kv.put = (async (...args: Parameters<typeof put>) => { calls++; await delay(); return put(...args); }) as typeof tcw.kv.put;
  tcw.kv.get = (async (...args: Parameters<typeof get>) => { calls++; await delay(); return get(...args); }) as typeof tcw.kv.get;
  tcw.kv.list = (async (...args: Parameters<typeof list>) => { calls++; await delay(); return list(...args); }) as typeof tcw.kv.list;
  const recording = { id, startedAt: Date.now(), durationMs: 52_000, mimeType: "audio/mp4", sizeBytes: 4,
    silencedMs: 0, silencedEvents: 0, noSignalMs: 0, options: { uploadAudio: true } };
  const start = performance.now();
  const saved = await saveVoiceNote(tcw, recording, { mimeType: "audio/mp4", size: 4,
    readPart: async () => new Uint8Array([1, 2, 3, 4]) }, "tauri");
  const elapsed = performance.now() - start;
  expect(saved.ok).toBe(true);
  expect(calls).toBe(10);
  // Compare against the observed sum of request delays, so concurrent test
  // load cannot turn a fixed wall-clock threshold into a false failure.
  expect(elapsed).toBeLessThan(serialLatency - 10);
});

test("a pending save failure is restored after volatile status is cleared", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "off", identifySpeakers: false });
    const started = await fake.plugin.start();
    await fake.plugin.stop();
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh();
    pendingStore.reportNoteFailure(started.id, Object.assign(new Error("Timed out"), { code: "VOICE_NOTE_OPERATION_TIMEOUT" }));
    pendingStore.setHeld(started.id, "unowned");
    await readPendingSaveStates(tcw.did, [started.id]);
    pendingStore.setAccount("did:other");
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh();
    for (let turn = 0; turn < 20 && !pendingStore.snapshot().notes?.find((note) => note.id === started.id)?.failed; turn++)
      await Bun.sleep(1);
    expect(pendingStore.snapshot().notes?.find((note) => note.id === started.id)).toMatchObject({
      failed: { kind: "timeout" }, held: "unowned",
    });
  } finally { __setVoiceNotesForTests(original, { available: null }); }
});

test("reconcile honors a persisted retry due time", async () => {
  const original = VoiceNotes;
  const { tcw, sqlite } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await ensureVoiceNoteIdentity(tcw);
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "off", identifySpeakers: false });
    const started = await fake.plugin.start();
    await fake.plugin.stop();
    await putPendingSaveState(tcw.did, { id: started.id, retryAt: Date.now() + 80 });
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh();
    const running = createVoiceNotePipeline(tcw).reconcileAll({
      did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration(),
    });
    await Bun.sleep(10);
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source_id = ?").all(started.id)).toEqual([]);
    await running;
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source_id = ?").all(started.id)).toEqual([]);
    for (let turn = 0; turn < 150 && sqlite.query("SELECT id FROM connector_meeting WHERE source_id = ?").all(started.id).length === 0; turn++)
      await Bun.sleep(1);
    expect(sqlite.query("SELECT id FROM connector_meeting WHERE source_id = ?").all(started.id)).toEqual([{ id: `vn-${started.id}` }]);
  } finally { __setVoiceNotesForTests(original, { available: null }); }
});

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

test("a persisted discard marker removes Markdown even when native audio is already gone", async () => {
  const original = VoiceNotes;
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const id = `discarded-note-${++count}`;
  try {
    await saveNote(id, "was on this phone");
    let marker = JSON.stringify([id]);
    await migrateLegacyDiscardLedger({ getItem: () => marker, removeItem: () => { marker = ""; } });
    expect(marker).toBe("");
    expect(await loadNote(id)).toBeNull();
  } finally { __setVoiceNotesForTests(original, { available: null }); }
});

test("a signed-out native note migrates its Markdown once with the T18 audio row", async () => {
  const original = VoiceNotes;
  const { tcw, sqlite, values } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await ensureSchema(tcw);
    const { id } = await fake.plugin.start();
    await fake.plugin.stop();
    await saveNote(id, "# Unowned draft\n- **0:03** bookmark");
    expect((await loadNote(id))?.moments).toEqual([{ atMs: 3_000, label: "bookmark" }]);
    const key = voiceNoteMarkdownKvKey(id);
    let notePuts = 0;
    const put = tcw.kv.put.bind(tcw.kv);
    tcw.kv.put = ((...args: Parameters<typeof put>) => {
      if (args[0] === key) notePuts++;
      return put(...args);
    }) as typeof tcw.kv.put;
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    const pipeline = createVoiceNotePipeline(tcw);
    const ctx = { did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() };
    await pipeline.reconcileAll(ctx);
    await pipeline.reconcileAll(ctx);
    expect(notePuts).toBe(1);
    expect(values.get(key)).toContain('recordingId: "' + id + '"');
    const beforeEdit = await readRecordingNoteFromSpace(tcw, id);
    expect(beforeEdit?.moments).toEqual([{ atMs: 3_000, label: "bookmark" }]);
    expect(row(sqlite, `vn-${id}`).metadata.note_kv_key).toBe(key);
    expect(beforeEdit?.savedEditAt).toBeNull();
    expect(values.get(key)).not.toContain("edited:");
    await saveNote(id, "# Edited later\n- **0:03** bookmark", { savedEdit: true });
    await syncRecordingNote(tcw, id);
    expect(notePuts).toBe(2);
    const afterEdit = await readRecordingNoteFromSpace(tcw, id);
    expect(afterEdit!.editedAt > beforeEdit!.editedAt).toBe(true);
    expect(afterEdit!.savedEditAt).toBe(afterEdit!.editedAt);
    expect(values.get(key)).toContain("edited: ");
  } finally { __setVoiceNotesForTests(original, { available: null }); }
});

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
  test("public transcript state prefers a terminal duplicate over a canonical pending hint", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw);
    expect((await ensureVoiceNoteIdentity(tcw)).status).toBe("established");
    insert(sqlite, "canonical", "rec", { transcription_outcome: "pending" });
    insert(sqlite, "duplicate", "rec", {
      transcription_outcome: "transcribed", transcript_text: "Legacy transcript", transcribed_at: "2026-01-02T00:00:00.000Z",
    }, "exo-voice-note-dup");
    expect(await readVoiceNoteTranscriptState(tcw, "rec")).toMatchObject({ status: "transcribed" });
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
  test("fresh rows skip the legacy outcome backfill and re-resolve", async () => {
    const { tcw } = space();
    await ensureSchema(tcw);
    await ensureVoiceNoteIdentity(tcw);
    const baseDb = tcw.sql.db.bind(tcw.sql);
    let backfills = 0;
    let resolves = 0;
    tcw.sql.db = ((name: string) => {
      const db = baseDb(name);
      return {
        ...db,
        query: async (sql: string, params?: unknown[], options?: unknown) => {
          if (sql.includes("SELECT id, source_id, metadata, created_at FROM connector_meeting WHERE source = 'exo-voice-note'"))
            resolves++;
          return db.query(sql, params as never, options as never);
        },
        execute: async (sql: string, params?: unknown[], options?: unknown) => {
          if (sql.includes("$.transcription_outcome")) backfills++;
          return db.execute(sql, params as never, options as never);
        },
      };
    }) as typeof tcw.sql.db;
    await createVoiceNoteRow(tcw, { id: "fresh", startedAt: 0, durationMs: 1000,
      mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Fresh");
    expect({ backfills, resolves }).toEqual({ backfills: 0, resolves: 1 });
  });
  test("new rows start pending and an off capture is recorded as skipped", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw);
    const pending = await createVoiceNoteRow(tcw, { id: "pending", startedAt: 0, durationMs: 1000,
      mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Pending note");
    const skipped = await createVoiceNoteRow(tcw, { id: "skipped", startedAt: 0, durationMs: 1000,
      mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
      options: { transcriber: "off", identifySpeakers: false } }, "Skipped note");
    expect(pending.metadata.transcription_outcome).toBe("pending");
    expect(skipped.metadata.transcription_outcome).toBe("skipped");
    expect(sqlite.query("SELECT COUNT(*) AS count FROM connector_meeting WHERE source='exo-voice-note'").get())
      .toEqual({ count: 2 });
  });

  test("legacy text without an outcome stays transcribed when an off-mode save reuses the row", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw);
    insert(sqlite, "legacy-text", "legacy-text", { transcript_text: "Earlier words" });
    await ensureVoiceNoteIdentity(tcw);
    const saved = await createVoiceNoteRow(tcw, { id: "legacy-text", startedAt: 0, durationMs: 1000,
      mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
      options: { transcriber: "off", identifySpeakers: false } }, "Existing note");
    expect(saved.metadata.transcription_outcome).toBeUndefined();
    expect(await readVoiceNoteTranscriptState(tcw, "legacy-text")).toEqual({
      status: "transcribed", preview: "Earlier words",
    });
  });

  test("re-save outcome backfill updates the row timestamp", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw);
    insert(sqlite, "legacy-pending", "legacy-pending");
    await ensureVoiceNoteIdentity(tcw);
    await createVoiceNoteRow(tcw, { id: "legacy-pending", startedAt: 0, durationMs: 1000,
      mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
      options: { transcriber: "off", identifySpeakers: false } }, "Existing note");
    expect(row(sqlite, "legacy-pending").updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });
  test("failed transcription is stored with its error code", async () => {
    const { tcw } = space();
    await ensureSchema(tcw);
    await createVoiceNoteRow(tcw, { id: "failed", startedAt: 0, durationMs: 1000,
      mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Failed note");
    await patchVoiceNoteTranscriptionFailure(tcw, "failed", "recording_too_large");
    expect((await resolveVoiceNoteRow(tcw, "failed"))?.metadata).toMatchObject({
      transcription_outcome: "failed",
      transcription_error_code: "recording_too_large",
    });
  });

  test("late failure preserves legacy transcript evidence", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw);
    insert(sqlite, "legacy-failure", "legacy-failure", { transcript_text: "Earlier words" });
    await ensureVoiceNoteIdentity(tcw);
    await patchVoiceNoteTranscriptionFailure(tcw, "legacy-failure", "service_busy");
    expect((await resolveVoiceNoteRow(tcw, "legacy-failure"))?.metadata.transcription_outcome).toBeUndefined();
    expect(await readVoiceNoteTranscriptState(tcw, "legacy-failure")).toEqual({
      status: "transcribed", preview: "Earlier words",
    });
  });

  test("a failed attempt after an authoritative rev-2 commit cannot write a failed mirror", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw);
    await createVoiceNoteRow(tcw, { id: "late-failure", startedAt: 0, durationMs: 1000,
      mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Late failure");
    await commitVoiceNoteTranscript(tcw, "late-failure", { rev: 2, outcome: "transcribed",
      text: "Newer committed words", sentences: sentence("Newer committed words") });
    sqlite.prepare(`UPDATE connector_meeting SET metadata = json_set(metadata,
      '$.transcription_outcome', 'pending', '$.transcription_error_code', NULL) WHERE source_id = ?`).run("late-failure");
    await patchVoiceNoteTranscriptionFailure(tcw, "late-failure", "service_busy");
    expect((await resolveVoiceNoteRow(tcw, "late-failure"))?.metadata.transcription_outcome).toBe("pending");
  });

  test("a successful commit removes an earlier failure code from its mirror", async () => {
    const { tcw } = space();
    await ensureSchema(tcw);
    await createVoiceNoteRow(tcw, { id: "recover", startedAt: 0, durationMs: 1000,
      mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Recovered");
    await patchVoiceNoteTranscriptionFailure(tcw, "recover", "service_busy");
    await commitVoiceNoteTranscript(tcw, "recover", { rev: 1, outcome: "transcribed",
      text: "Recovered words", sentences: sentence("Recovered words") });
    expect((await resolveVoiceNoteRow(tcw, "recover"))?.metadata).not.toHaveProperty("transcription_error_code");
  });

  test("deferral codes do not persist failed outcomes", async () => {
    for (const code of ["audio_upload_pending", "transcription_off", "upload_outcome_unknown", "account_changed",
      "active_transcription_exists", "transcript_save_timed_out"]) {
      const { tcw } = space();
      await ensureSchema(tcw);
      await createVoiceNoteRow(tcw, { id: code, startedAt: 0, durationMs: 1000,
        mimeType: "audio/mp4", sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Deferred");
      await patchVoiceNoteTranscriptionFailure(tcw, code, code);
      expect((await resolveVoiceNoteRow(tcw, code))?.metadata.transcription_outcome, code).toBe("pending");
    }
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
  test("archived sweep moves the new VAD diagnostic metadata to the keeper", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw);
    insert(sqlite, "a", "rec", { transcription_outcome: "no_speech", transcription_vad_mode: "primary",
      transcription_noise_floor_dbfs: -40 });
    insert(sqlite, "b", "rec", {
      transcription_outcome: "transcribed", transcript_text: "synthetic transcript",
      transcribed_at: "2026-01-02T00:00:00.000Z",
      transcription_vad_mode: "quiet", transcription_noise_floor_dbfs: -61.5, transcription_median_dbfs: -58,
      transcription_p99_dbfs: -29, transcription_speech_peak_s: 2.4, transcription_vad_dropped_above_noise_pct: 3.5,
    });
    await reconcileDuplicates(tcw);
    await sweepArchived(tcw);
    expect(row(sqlite, "a").metadata).toMatchObject({
      transcription_vad_mode: "quiet", transcription_noise_floor_dbfs: -61.5, transcription_median_dbfs: -58,
      transcription_p99_dbfs: -29, transcription_speech_peak_s: 2.4, transcription_vad_dropped_above_noise_pct: 3.5,
    });
    expect(row(sqlite, "b").metadata.merged_at).toBe(row(sqlite, "b").updatedAt);
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
  test("commit provenance binds timing to the durable body when the row mirror fails", async () => {
    const { tcw, sqlite, values } = space();
    await ensureSchema(tcw);
    insert(sqlite, "vn-rec", "rec");
    await ensureVoiceNoteIdentity(tcw);
    const sentences = [
      { index: 0, speaker_name: "You", text: "First synthetic sentence.", start_time: 0, end_time: 45 },
      { index: 1, speaker_name: "You", text: "Second synthetic sentence.", start_time: 60, end_time: 105 },
    ];
    await commitVoiceNoteTranscript(tcw, "rec", { rev: 3, outcome: "transcribed", text: "PTX rev 3",
      sentences, engine: "private-cloud", provider: "tinycloud-private-transcription" });
    const originalDb = tcw.sql.db.bind(tcw.sql);
    tcw.sql.db = ((name: string) => ({ ...originalDb(name), execute: async (statement: string, params: unknown[] = []) =>
      statement.includes("UPDATE connector_meeting SET metadata = json_patch")
        ? { ok: false, error: { code: "SQL_ERROR", message: "mirror update refused" } }
        : originalDb(name).execute(statement, params as never[]),
    })) as typeof tcw.sql.db;
    await expect(commitVoiceNoteTranscript(tcw, "rec", { rev: 4, outcome: "transcribed", text: "Local rev 4",
      sentences, engine: "whispercpp", provider: "whispercpp" })).rejects.toThrow("mirror update refused");

    const locator = await voiceNoteTranscriptLocator(tcw, "rec");
    expect(locator).toMatchObject({ committed: true, provenance: { engine: "whispercpp", provider: "whispercpp" } });
    expect(row(sqlite, "vn-rec").metadata).toMatchObject({
      transcription_engine: "private-cloud", transcript_provider: "tinycloud-private-transcription",
    });
    const savedSentences = JSON.parse(values.get(locator.bodyKey!)!) as typeof sentences;
    const privateCloud = hasPrivateCloudTimingProvenance(null, locator.provenance);
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(NoteDetailView, {
      item: { id: "vn-rec", source: "exo-voice-note", sourceId: "rec", title: "Synthetic", startedAt: "2026-01-01T00:00:00Z", durationSecs: 120 },
      listStatus: "ready",
      metadata: { status: "ok", metadata: row(sqlite, "vn-rec").metadata },
      transcript: { status: "ok", sentences: savedSentences },
      transcriptProvenance: locator.provenance,
      audio: { load: async () => null },
      copyState: "idle",
      onCopy: () => {},
      onCopyWithTimestamps: () => {},
      onRetry: () => {},
      pushed: true,
      onBack: () => {},
    })));
    expect(html).not.toContain('aria-label="Play from 1:00"');
    expect(html).not.toContain("Copy with timestamps");
    expect(transcriptWithTimestamps(savedSentences, privateCloud)).not.toContain("[01:00]");
    expect(transcriptMarkdown("Synthetic", "2026-01-01T00:00:00Z", savedSentences, privateCloud)).not.toContain("[01:00]");
  });

  test("a PTX commit remains timed when its row mirror has lost provenance", async () => {
    const { tcw, sqlite, values } = space();
    await ensureSchema(tcw);
    insert(sqlite, "vn-rec", "rec");
    await ensureVoiceNoteIdentity(tcw);
    const sentences = [
      { index: 0, speaker_name: "You", text: "First synthetic sentence.", start_time: 0, end_time: 45 },
      { index: 1, speaker_name: "You", text: "Second synthetic sentence.", start_time: 60, end_time: 105 },
    ];
    await commitVoiceNoteTranscript(tcw, "rec", { rev: 3, outcome: "transcribed", text: "PTX",
      sentences, engine: "private-cloud", provider: "tinycloud-private-transcription" });
    sqlite.prepare("UPDATE connector_meeting SET metadata = ? WHERE id = 'vn-rec'").run(JSON.stringify({
      transcription_outcome: "transcribed", transcript_text: "PTX",
    }));
    const locator = await voiceNoteTranscriptLocator(tcw, "rec");
    expect(locator.provenance).toEqual({ engine: "private-cloud", provider: "tinycloud-private-transcription" });
    const savedSentences = JSON.parse(values.get(locator.bodyKey!)!) as typeof sentences;
    const privateCloud = hasPrivateCloudTimingProvenance(null, locator.provenance);
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(NoteDetailView, {
      item: { id: "vn-rec", source: "exo-voice-note", sourceId: "rec", title: "Synthetic", startedAt: "2026-01-01T00:00:00Z", durationSecs: 120 },
      listStatus: "ready",
      metadata: { status: "ok", metadata: row(sqlite, "vn-rec").metadata },
      transcript: { status: "ok", sentences: savedSentences },
      transcriptProvenance: locator.provenance,
      audio: { load: async () => null },
      copyState: "idle",
      onCopy: () => {},
      onCopyWithTimestamps: () => {},
      onRetry: () => {},
      pushed: true,
      onBack: () => {},
    })));
    expect(html).toContain('aria-label="Play from 1:00"');
    expect(html).toContain("Copy with timestamps");
    expect(transcriptWithTimestamps(savedSentences, privateCloud)).toContain("[01:00]");
    expect(transcriptMarkdown("Synthetic", "2026-01-01T00:00:00Z", savedSentences, privateCloud)).toContain("[01:00]");
  });
  test("upgrade, downgrade, upgrade restores richer same-revision transcript", async () => {
    const { tcw, sqlite, values } = space();
    await ensureSchema(tcw); insert(sqlite, "vn-rec", "rec");
    const rich = [{ index: 0, speaker_name: null, text: "hello", start_time: 0, end_time: 65,
      channel: 0 as const, speaker_id: "speaker_0", timing: "coarse" as const }];
    const poor = [{ index: 0, speaker_name: "You", text: "hello", start_time: 0, end_time: 65 }];
    const upgraded = await commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "transcribed", text: "hello", sentences: rich });
    const oldHash = await transcriptHash(poor);
    const oldKey = transcriptRevKvKey("exo-voice-note", "rec", oldHash);
    values.set(oldKey, JSON.stringify(poor));
    // 0.7.1 can still overwrite the SQL pointer with its hash-only same-revision CAS.
    sqlite.prepare("UPDATE voice_note_transcript SET hash = ?, body_key = ? WHERE source_id = 'rec'").run(oldHash, oldKey);
    expect((await readTranscriptCommit(tcw, "rec"))?.hash).toBe(oldHash);
    await commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "transcribed", text: "hello", sentences: rich });
    expect((await readTranscriptCommit(tcw, "rec"))?.hash).toBe(upgraded.hash);
    await commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "transcribed", text: "hello", sentences: poor });
    expect((await readTranscriptCommit(tcw, "rec"))?.hash).toBe(upgraded.hash);
    expect(values.get((await voiceNoteTranscriptLocator(tcw, "rec")).bodyKey)).toContain('"speaker_id":"speaker_0"');
  });
  test("same-revision comparison accepts an already-parsed KV sentence array", async () => {
    const { tcw, sqlite } = space();
    await ensureSchema(tcw); insert(sqlite, "vn-rec", "rec");
    await commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "transcribed", text: "hello", sentences: sentence("hello") });
    const get = tcw.kv.get.bind(tcw.kv);
    tcw.kv.get = (async (key: string, options?: unknown) => {
      const result = await get(key, options as never);
      return result.ok && key.includes("/transcript-rev/")
        ? { ok: true, data: { data: JSON.parse(result.data.data as string) } } : result;
    }) as typeof tcw.kv.get;
    const rich = [{ ...sentence("hello")[0]!, channel: 0 as const, timing: "engine" as const }];
    const committed = await commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "transcribed", text: "hello", sentences: rich });
    expect(committed.hash).toBe(await transcriptHash(rich));
  });
  test("a poorer same-revision writer between comparison and INSERT is repaired", async () => {
    const { tcw, sqlite, values } = space();
    await ensureSchema(tcw); insert(sqlite, "vn-rec", "rec");
    const initial = sentence("initial");
    await commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "transcribed", text: "initial", sentences: initial });
    const poor = sentence("hello");
    const rich = [{ ...poor[0]!, channel: 0 as const, speaker_id: "speaker_0", timing: "engine" as const }];
    const poorHash = await transcriptHash(poor);
    const poorKey = transcriptRevKvKey("exo-voice-note", "rec", poorHash);
    values.set(poorKey, JSON.stringify(poor));
    const originalDb = tcw.sql.db.bind(tcw.sql);
    let intervened = false;
    tcw.sql.db = ((name: string) => ({ ...originalDb(name), execute: async (statement: string, params: unknown[] = []) => {
      if (!intervened && statement.startsWith("INSERT INTO voice_note_transcript")) {
        intervened = true;
        sqlite.prepare("UPDATE voice_note_transcript SET hash = ?, body_key = ? WHERE source_id = 'rec'").run(poorHash, poorKey);
      }
      return originalDb(name).execute(statement, params as never[]);
    } })) as typeof tcw.sql.db;
    const result = await commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "transcribed", text: "hello", sentences: rich });
    expect(intervened).toBe(true);
    expect(result.hash).toBe(await transcriptHash(rich));
    expect((await readTranscriptCommit(tcw, "rec"))?.hash).toBe(result.hash);
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
      AND g.source IN ('exo-voice-note', 'exo-voice-note-dup')
      AND json_extract(g.metadata, '$.transcription_outcome') IN ('transcribed', 'no_speech')
      ORDER BY COALESCE(json_extract(g.metadata, '$.transcribed_at'), '') DESC, g.id ASC LIMIT 1`).get() as { id: string };
    expect(ts).toBe(sqlWinner.id);
    expect((sqlite.query(SQL_MEETING_METADATA_QUERY).all() as { source_id: string }[]).some((r) => r.source_id === "rec")).toBe(true);
    await commitVoiceNoteTranscript(tcw, "rec", { rev: 1, outcome: "no_speech", text: null, sentences: [] });
    expect((sqlite.query(SQL_MEETING_METADATA_QUERY).all() as { source_id: string }[]).some((r) => r.source_id === "rec")).toBe(false);
  });
});

test("a failed space setup marks every pending upload retryable", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "off", identifySpeakers: false });
    await fake.plugin.start();
    const recording = await fake.plugin.stop();
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh();
    const originalDb = tcw.sql.db.bind(tcw.sql);
    tcw.sql.db = ((name: string) => ({ ...originalDb(name), execute: async (statement: string, params: unknown[] = []) =>
      statement.includes("CREATE TABLE IF NOT EXISTS voice_note_transcript")
        ? { ok: false, error: { code: "SERVER_ERROR", message: "schema temporarily unavailable", meta: { status: 500 } } }
        : originalDb(name).execute(statement, params as never[]),
    })) as typeof tcw.sql.db;
    const pipeline = createVoiceNotePipeline(tcw);
    await expect(pipeline.reconcileAll({ did: tcw.did, spaceId: tcw.spaceId,
      generation: currentAccountGeneration() })).rejects.toThrow("schema temporarily unavailable");
    expect(pendingStore.snapshot().notes?.find((note) => note.id === recording.id)?.failed)
      .toMatchObject({ kind: "server" });
    expect(pendingStore.snapshot().notes?.find((note) => note.id === recording.id)?.upload).toBeUndefined();
  } finally {
    pendingStore.setAccount(null);
    __setVoiceNotesForTests(original, { available: null });
  }
});

test("an unanswered space setup ends as a visible timeout", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  setVoiceNoteSaveDeadlineForTests(15);
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "off", identifySpeakers: false });
    await fake.plugin.start();
    const recording = await fake.plugin.stop();
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh();
    const originalDb = tcw.sql.db.bind(tcw.sql);
    tcw.sql.db = ((name: string) => ({ ...originalDb(name), query: async (statement: string, params: unknown[] = []) =>
      statement.includes("SELECT name FROM sqlite_master")
        ? new Promise<never>(() => undefined)
        : originalDb(name).query(statement, params as never[]),
    })) as typeof tcw.sql.db;
    const pipeline = createVoiceNotePipeline(tcw);
    await expect(pipeline.reconcileAll({ did: tcw.did, spaceId: tcw.spaceId,
      generation: currentAccountGeneration() })).rejects.toThrow("Saving to your TinyCloud space is slow");
    expect(pendingStore.snapshot().notes?.find((note) => note.id === recording.id)?.failed)
      .toMatchObject({ kind: "timeout" });
  } finally {
    setVoiceNoteSaveDeadlineForTests(null);
    pendingStore.setAccount(null);
    __setVoiceNotesForTests(original, { available: null });
  }
});

test("a setup Result error keeps its message rather than rendering an object", async () => {
  const { tcw } = space();
  const originalDb = tcw.sql.db.bind(tcw.sql);
  tcw.sql.db = ((name: string) => ({ ...originalDb(name), query: async (statement: string, params: unknown[] = []) =>
    statement.includes("SELECT name FROM sqlite_master")
      ? { ok: false, error: { code: "NETWORK_ERROR", message: "The node is unavailable" } }
      : originalDb(name).query(statement, params as never[]),
  })) as typeof tcw.sql.db;
  const result = await ensureVoiceNoteIdentity(tcw);
  expect(result.status).toBe("retry");
  expect(result.reason).toContain("The node is unavailable");
  expect(result.reason).not.toContain("[object Object]");
});

test("cancelAll stops an upload at its next KV checkpoint and quiescent waits", async () => {
  const original = VoiceNotes;
  const { tcw, values } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false, uploadAudio: true });
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

test("sign-in and manual reconciliation emit only for notes first landed by recovery", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const events: unknown[] = [];
  const off = captureEvents.on("library-changed", (event) => events.push(event));
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: "did:test:other", transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    await fake.plugin.start();
    const other = await fake.plugin.stop();
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 2,
      transcriber: "on-device", identifySpeakers: false });
    await fake.plugin.start();
    const recovered = await fake.plugin.stop();
    await fake.plugin.start();
    const stopped = await fake.plugin.stop();
    const pipeline = createVoiceNotePipeline(tcw);
    const ctx = { did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() };
    await pipeline.process(ctx, stopped.id);
    expect(events).toEqual([]); // The recorder callback owns the initial Stop event.
    await pipeline.reconcileAll(ctx);
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: recovered.id }]);
    expect((await fake.plugin.listPending()).recordings.find((note) => note.id === other.id)?.ledger?.audio.state)
      .toBe("pending");
    await pipeline.reconcileAll(ctx, "manual");
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: recovered.id }]);
    await fake.plugin.start();
    const manual = await fake.plugin.stop();
    await pipeline.reconcileAll(ctx, "manual");
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: recovered.id },
      { source: VOICE_NOTE_SOURCE, sourceId: manual.id }]);
    await pipeline.reconcileAll(ctx);
    expect(events).toHaveLength(2);
  } finally { off(); __setVoiceNotesForTests(original, { available: null }); }
});

test("failed recovery emits nothing, and a later successful retry emits once", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const events: unknown[] = [];
  const off = captureEvents.on("library-changed", (event) => events.push(event));
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false, uploadAudio: true });
    await fake.plugin.start();
    const note = await fake.plugin.stop();
    const put = tcw.kv.put.bind(tcw.kv);
    let offline = true;
    tcw.kv.put = (async (key: string, value: unknown, opts: unknown) =>
      offline && key.includes("/audio/")
        ? { ok: false, error: { code: "OFFLINE", message: "no connection" } }
        : put(key, value as never, opts as never)) as typeof tcw.kv.put;
    const pipeline = createVoiceNotePipeline(tcw);
    const ctx = { did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() };
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh();
    // A note that cannot upload is reported against that note, not thrown out of the pass.
    await pipeline.reconcileAll(ctx);
    expect(pendingStore.snapshot().notes?.find((pending) => pending.id === note.id)?.failed).toBeDefined();
    expect(events).toEqual([]);
    offline = false;
    await pipeline.reconcileAll(ctx, "manual");
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: note.id }]);
    await pipeline.reconcileAll(ctx, "manual");
    expect(events).toHaveLength(1);
  } finally { off(); __setVoiceNotesForTests(original, { available: null }); }
});

test("a local transcript finished before audio upload commits to the space afterward", async () => {
  const original = VoiceNotes;
  const originalWindow = globalThis.window;
  globalThis.window = { ...originalWindow, __TAURI_INTERNALS__: {} } as Window & typeof globalThis;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    await fake.plugin.start();
    const note = await fake.plugin.stop();
    await fake.plugin.putTranscript({ id: note.id, transcript: {
      version: 1, noteId: note.id, transcriber: "on-device", rev: 1, engine: "whispercpp",
      model: "QuantizedTinyEn", language: "en", outcome: "transcribed", diarized: false,
      segments: [{ start: 0, end: 1000, text: "Local words", speaker: null }], createdAt: "2026-10-13T10:00:00.000Z",
    } });
    const originalRead = fake.plugin.getTranscript.bind(fake.plugin);
    const readGate = Promise.withResolvers<void>();
    const readStarted = Promise.withResolvers<void>();
    fake.plugin.getTranscript = async (args) => { readStarted.resolve(); await readGate.promise; return originalRead(args); };
    const pipeline = createVoiceNotePipeline(tcw);
    const saving = pipeline.process({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() }, note.id);
    try {
      expect(await Promise.race([saving.then(() => "uploaded"), Bun.sleep(500).then(() => "blocked")])).toBe("uploaded");
      await readStarted.promise;
    } finally { readGate.resolve(); }
    let commit = await readTranscriptCommit(tcw, note.id);
    for (let i = 0; i < 30 && !commit; i++) { await Bun.sleep(1); commit = await readTranscriptCommit(tcw, note.id); }
    expect(commit).toMatchObject({ sourceId: note.id, rev: 1, outcome: "transcribed" });
    expect((await tcw.kv.get(commit!.bodyKey)).ok).toBe(true);
    expect((await tcw.kv.get(transcriptKvKey(VOICE_NOTE_SOURCE, note.id))).ok).toBe(true);
  } finally { globalThis.window = originalWindow; __setVoiceNotesForTests(original, { available: null }); }
});

test("phone upload leaves transcript sync to recordRowId and the transcribed listener", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    await fake.plugin.start();
    const note = await fake.plugin.stop();
    let transcriptReads = 0;
    const originalRead = fake.plugin.getTranscript.bind(fake.plugin);
    fake.plugin.getTranscript = async (args) => { transcriptReads++; return originalRead(args); };
    const pipeline = createVoiceNotePipeline(tcw);
    await pipeline.process({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() }, note.id);
    expect(transcriptReads).toBe(0);
  } finally { __setVoiceNotesForTests(original, { available: null }); }
});

for (const transition of ["late account change", "cancellation"] as const) {
test(`recovery interrupted by ${transition} cannot emit into the next pass`, async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const events: unknown[] = [];
  const off = captureEvents.on("library-changed", (event) => events.push(event));
  let release = () => {};
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false, uploadAudio: true });
    await fake.plugin.start();
    const note = await fake.plugin.stop();
    const reachedPart = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    release = gate.resolve;
    const put = tcw.kv.put.bind(tcw.kv);
    tcw.kv.put = (async (key: string, value: unknown, opts: unknown) => {
      if (key.includes("/audio/") && key.includes("/p/")) { reachedPart.resolve(); await gate.promise; }
      return put(key, value as never, opts as never);
    }) as typeof tcw.kv.put;
    const pipeline = createVoiceNotePipeline(tcw);
    const ctx = { did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() };
    const saving = pipeline.reconcileAll(ctx);
    await reachedPart.promise;
    const nextGeneration = transition === "late account change" ? advanceAccountGeneration() : ctx.generation;
    if (transition === "cancellation") { pipeline.cancelAll(); pipeline.resume(); }
    release();
    await expect(saving).rejects.toThrow();
    expect(events).toEqual([]);
    await pipeline.reconcileAll({ ...ctx, generation: nextGeneration });
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: note.id }]);
  } finally { release(); off(); __setVoiceNotesForTests(original, { available: null }); }
});
}

test("the mounted pending saver runs the real pipeline on sign-in and forced-swap recovery", async () => {
  const original = VoiceNotes;
  const previousStt = OnDeviceStt;
  const previousWindow = globalThis.window;
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const fake = createFakeVoiceNotes();
  const { tcw } = space();
  let failedEventId: string | null = null;
  const nativeListPending = fake.plugin.listPending.bind(fake.plugin);
  fake.plugin.listPending = async () => {
    const listed = await nativeListPending();
    return failedEventId ? { ...listed, recordings: listed.recordings.map((recording) => recording.id === failedEventId
      ? { ...recording, stt: { state: "failed" as const } } : recording) } : listed;
  };
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const sttListeners = new Map<string, (event: { id: string }) => void>();
  __setOnDeviceSttForTests({ addListener: async (event: string, listener: (event: { id: string }) => void) => {
    sttListeners.set(event, listener);
    return { remove: async () => { sttListeners.delete(event); } };
  } } as unknown as OnDeviceSttPlugin);
  const documentStub = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {},
    createElement: () => hostNode(), createTextNode: () => hostNode() };
  function hostNode(): unknown {
    return new Proxy(function () {}, { get: (_target, key) => key === "nodeType" ? 1 : key === "ownerDocument" ? documentStub
      : key === "style" ? {} : key === "firstChild" || key === "parentNode" ? null : () => hostNode(), set: () => true });
  }
  Reflect.set(globalThis, "window", { HTMLIFrameElement: class {}, document: documentStub,
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: documentStub, textContent: "",
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, insertBefore() {} } as unknown as HTMLElement);
  let mounted = true;
  const events: unknown[] = [];
  let expectedId: string | null = null;
  let landed = Promise.withResolvers<void>();
  const off = captureEvents.on("library-changed", (event) => {
    events.push(event);
    if (event?.sourceId === expectedId) landed.resolve();
  });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    await fake.plugin.start();
    const initial = await fake.plugin.stop();
    expectedId = initial.id;
    const pipeline = createVoiceNotePipeline(tcw);
    await act(async () => root.render(createElement(PendingVoiceNotesSaver,
      { tcw, pipeline, backendUrl: "", sessionStore: {} as never })));
    await act(async () => landed.promise);
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: initial.id }]);

    fake.plugin.getTranscript = async () => ({ transcript: null });
    failedEventId = initial.id;
    landed = Promise.withResolvers<void>();
    sttListeners.get("failed")?.({ id: initial.id });
    await landed.promise;
    expect((await resolveVoiceNoteRow(tcw, initial.id))?.metadata.transcription_outcome).toBe("failed");
    failedEventId = null;
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: initial.id },
      { source: VOICE_NOTE_SOURCE, sourceId: initial.id }]);

    fake.plugin.getTranscript = async () => ({ transcript: {
      version: 1, noteId: initial.id, transcriber: "on-device", rev: 1,
      engine: "apple-speech", model: null, language: "en", outcome: "transcribed",
      diarized: false, segments: [{ start: 0, end: 1000, text: "Saved locally", speaker: null }],
      createdAt: "2026-10-03T10:00:00.000Z",
    } });
    await syncOnDeviceTranscript(tcw, { id: initial.id, ledger: { audio: { state: "saved" } } });
    expect(await readTranscriptCommit(tcw, initial.id)).toMatchObject({ rev: 1 });
    expect((await resolveVoiceNoteRow(tcw, initial.id))?.metadata).not.toHaveProperty("transcription_stats_missing");
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: initial.id },
      { source: VOICE_NOTE_SOURCE, sourceId: initial.id },
      { source: VOICE_NOTE_SOURCE, sourceId: initial.id }]);
    fake.plugin.getTranscript = async () => ({ transcript: null });

    await fake.plugin.start();
    const swapped = await fake.plugin.stop();
    expectedId = swapped.id;
    landed = Promise.withResolvers<void>();
    schedulePendingVoiceNotesRecovery();
    await act(async () => landed.promise);
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: initial.id },
      { source: VOICE_NOTE_SOURCE, sourceId: initial.id },
      { source: VOICE_NOTE_SOURCE, sourceId: initial.id },
      { source: VOICE_NOTE_SOURCE, sourceId: swapped.id }]);
    expect((await fake.plugin.listPending()).recordings.filter((note) => note.ledger?.audio.state === "saved"))
      .toHaveLength(2);
    await act(async () => root.unmount());
    mounted = false;
    fake.plugin.getTranscript = async () => ({ transcript: {
      version: 1, noteId: initial.id, transcriber: "on-device", rev: 2,
      engine: "apple-speech", model: null, language: "en", outcome: "transcribed",
      diarized: false, segments: [{ start: 0, end: 1000, text: "Arrived after sign-out", speaker: null }],
      createdAt: "2026-10-03T10:01:00.000Z",
    } });
    // The saver's unmount paused the account's work: the late sync is abandoned (the next launch's catch-up saves it) and silent.
    await syncOnDeviceTranscript(tcw, { id: initial.id, ledger: { audio: { state: "saved" } } });
    expect(await readTranscriptCommit(tcw, initial.id)).toMatchObject({ rev: 1 });
    expect(events).toHaveLength(4);
  } finally {
    if (mounted) await act(async () => root.unmount());
    off();
    __setOnDeviceSttForTests(previousStt);
    __setVoiceNotesForTests(original, { available: null });
    Reflect.set(globalThis, "window", previousWindow);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});
test("Mac Whisper transcript sync never sets PTX missing-stats metadata", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const id = "desktop-whisper";
  await ensureSchema(tcw);
  await createVoiceNoteRow(tcw, { id, startedAt: 0, durationMs: 1_000, mimeType: "audio/mpeg",
    sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Whisper note");
  const transcript = whisperLocalTranscript({ id, durationMs: 1_000 }, "base" as never, {
    results: { channels: [{ alternatives: [{ transcript: "Saved by desktop Whisper", words: [] }] }] },
  } as never);
  __setVoiceNotesForTests({
    listPending: async () => ({ recordings: [{ id, owner: tcw.did, rev: 1, ledger: { audio: { state: "saved" } } }] }),
    getTranscript: async () => ({ transcript }),
    updateLedger: async () => ({}),
  } as unknown as typeof VoiceNotes, { available: true });
  try {
    await syncOnDeviceTranscript(tcw, { id, owner: tcw.did, ledger: { audio: { state: "saved" } } });
    expect((await resolveVoiceNoteRow(tcw, id))?.metadata).not.toHaveProperty("transcription_stats_missing");
  } finally { __setVoiceNotesForTests(original, { available: null }); }
});
test("on-device no_speech transcript sync never sets PTX missing-stats metadata", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const id = "on-device-no-speech";
  await ensureSchema(tcw);
  await createVoiceNoteRow(tcw, { id, startedAt: 0, durationMs: 1_000, mimeType: "audio/mp4",
    sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Silent note");
  const transcript = {
    version: 1, noteId: id, transcriber: "on-device", rev: 1, engine: "apple-speech", model: null, language: "en",
    outcome: "no_speech", diarized: false, segments: [], createdAt: "2026-10-03T10:00:00.000Z",
  };
  __setVoiceNotesForTests({
    listPending: async () => ({ recordings: [{ id, owner: tcw.did, rev: 1, ledger: { audio: { state: "saved" } } }] }),
    getTranscript: async () => ({ transcript }),
    updateLedger: async () => ({}),
  } as unknown as typeof VoiceNotes, { available: true });
  try {
    await syncOnDeviceTranscript(tcw, { id, owner: tcw.did, ledger: { audio: { state: "saved" } } });
    expect(await readTranscriptCommit(tcw, id)).toMatchObject({ outcome: "no_speech" });
    expect((await resolveVoiceNoteRow(tcw, id))?.metadata).not.toHaveProperty("transcription_stats_missing");
  } finally { __setVoiceNotesForTests(original, { available: null }); }
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
    await pipeline.process(ctx, fresh.id, "background");
    await pipeline.reconcileAll(ctx);
    await pipeline.reconcileAll(ctx, "manual");
    const notes = (await fake.plugin.listPending()).recordings;
    expect(notes.find((note) => note.id === old.id)?.ledger?.audio.state).toBe("pending");
    expect(notes.find((note) => note.id === fresh.id)?.ledger?.audio.state).toBe("saved");
  } finally { __setVoiceNotesForTests(previous, { available: null }); }
});

test("reconcile refreshes the pending count after each note save", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  let now = 100;
  const fake = createFakeVoiceNotes(() => now);
  __setVoiceNotesForTests(fake.plugin, { available: true });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let enteredSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => { enteredSecond = resolve; });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "off", identifySpeakers: false, uploadAudio: true });
    await fake.plugin.start();
    const first = await fake.plugin.stop();
    now++;
    await fake.plugin.start();
    const second = await fake.plugin.stop();
    const readAudioChunk = fake.plugin.readAudioChunk.bind(fake.plugin);
    fake.plugin.readAudioChunk = (async (options: Parameters<typeof readAudioChunk>[0]) => {
      if (options.id === second.id) {
        enteredSecond();
        await secondGate;
      }
      return readAudioChunk(options);
    }) as typeof fake.plugin.readAudioChunk;

    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh();
    expect(pendingStore.snapshot().listing).toEqual({ state: "ok", count: 2 });
    pendingStore.reportNoteFailure(second.id, "previous attempt failed");
    expect(pendingStore.snapshot().notes?.find((note) => note.id === second.id)?.failed).toMatchObject({ kind: "other" });
    const pipeline = createVoiceNotePipeline(tcw);
    const reconcile = pipeline.reconcileAll({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() });
    await secondStarted;
    expect(pendingStore.snapshot().notes?.find((note) => note.id === second.id)?.waitingBehind).toBe(0);
    expect(pendingStore.snapshot().lastError).toBeNull();
    expect(pendingStore.snapshot().notes?.find((note) => note.id === second.id)?.failed).toBeUndefined();
    expect(pendingStore.snapshot().listing).toEqual({ state: "ok", count: 1 });
    expect((await fake.plugin.listPending()).recordings.find((note) => note.id === first.id)?.ledger?.audio.state).toBe("saved");
    releaseSecond();
    await reconcile;
    expect(pendingStore.snapshot().listing).toEqual({ state: "ok", count: 0 });
  } finally {
    releaseSecond();
    pendingStore.setAccount(null);
    __setVoiceNotesForTests(original, { available: null });
  }
});

test("reconcile publishes the full upload queue and decrements notes ahead as they settle", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const recordings: Awaited<ReturnType<typeof fake.plugin.stop>>[] = [];
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let enterFirst!: () => void;
  let enterSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const firstStarted = new Promise<void>((resolve) => { enterFirst = resolve; });
  const secondStarted = new Promise<void>((resolve) => { enterSecond = resolve; });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "off", identifySpeakers: false, uploadAudio: true });
    for (let index = 0; index < 3; index++) {
      await fake.plugin.start();
      recordings.push(await fake.plugin.stop());
    }
    const readAudioChunk = fake.plugin.readAudioChunk.bind(fake.plugin);
    fake.plugin.readAudioChunk = (async (options: Parameters<typeof readAudioChunk>[0]) => {
      if (options.id === recordings[0]!.id) { enterFirst(); await firstGate; }
      if (options.id === recordings[1]!.id) { enterSecond(); await secondGate; }
      return readAudioChunk(options);
    }) as typeof fake.plugin.readAudioChunk;
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh();
    const pipeline = createVoiceNotePipeline(tcw, { retryDelaysMs: [] });
    const reconcile = pipeline.reconcileAll({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() });
    await firstStarted;
    const queued = pendingStore.snapshot().notes ?? [];
    expect(recordings.map(({ id }) => queued.find((note) => note.id === id)?.waitingBehind)).toEqual([0, 1, 2]);
    expect(recordings.map(({ id }) => queued.find((note) => note.id === id)?.upload?.state)).toEqual([
      "uploading", "waiting", "waiting",
    ]);
    releaseFirst();
    await secondStarted;
    const afterFirst = pendingStore.snapshot().notes ?? [];
    expect(recordings.map(({ id }) => afterFirst.find((note) => note.id === id)?.waitingBehind)).toEqual([undefined, 0, 1]);
    expect(afterFirst.find((note) => note.id === recordings[1]!.id)?.upload?.state).toBe("uploading");
    releaseSecond();
    await reconcile;
  } finally {
    releaseFirst();
    releaseSecond();
    pendingStore.setAccount(null);
    __setVoiceNotesForTests(original, { available: null });
  }
});

async function pipelineFailureMessage(failure: "kv-403" | "sql-500"): Promise<string | null> {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "off", identifySpeakers: false, uploadAudio: true });
    await fake.plugin.start();
    await fake.plugin.stop();
    if (failure === "kv-403") {
      tcw.kv.list = (async () => ({ ok: false, error: {
        code: "NETWORK_ERROR", message: "Failed to list keys: 403 - capability tinycloud.kv/list not granted",
      } })) as typeof tcw.kv.list;
    } else {
      const db = tcw.sql.db.bind(tcw.sql);
      tcw.sql.db = ((name: string) => {
        const connection = db(name);
        const execute = connection.execute.bind(connection);
        return { ...connection, execute: (async (statement: string, ...args: unknown[]) => {
          if (statement.startsWith("INSERT INTO connector_meeting")) {
            return { ok: false, error: { code: "NETWORK_ERROR", message: "Failed to execute query: 500 - internal server error" } };
          }
          return execute(statement, ...args as never[]);
        }) as typeof connection.execute };
      }) as typeof tcw.sql.db;
    }
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh(null);
    await createVoiceNotePipeline(tcw, { retryDelaysMs: [] }).reconcileAll({
      did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration(),
    });
    return pendingStore.snapshot().lastError;
  } finally {
    __setVoiceNotesForTests(original, { available: null });
    pendingStore.setAccount(null);
    await pendingStore.refresh(null);
  }
}

test("a kv.list 403 stays visible as its own message", async () => {
  expect(await pipelineFailureMessage("kv-403")).toContain("Failed to list keys: 403 - capability tinycloud.kv/list not granted");
});

test("a SQL 500 stays visible as its own message", async () => {
  expect(await pipelineFailureMessage("sql-500")).toContain("Failed to execute query: 500 - internal server error");
});

test("a wrapped CORS-hidden upload refusal shows node rejection copy without leaking its URL", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const originalPut = tcw.kv.put.bind(tcw.kv);
  const rawUrl = "https://space.example/kv?token=private-token";
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "off", identifySpeakers: false, uploadAudio: true });
    const { id } = await fake.plugin.start();
    await fake.plugin.stop();
    tcw.kv.put = (async (key, value, options) => key.includes("/audio/")
      ? { ok: false, error: { code: "NETWORK_ERROR",
        message: `Fetch API cannot load ${rawUrl} due to access control checks.` } }
      : originalPut(key, value, options)) as typeof tcw.kv.put;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh(null);
    const pipeline = createVoiceNotePipeline(tcw, { retryDelaysMs: [] });
    await pipeline.reconcileAll({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() });

    expect(pendingStore.snapshot().lastError).toBe(
      "The TinyCloud node rejected this upload. This note is safe on this browser — try again after the node is fixed.",
    );
    expect(pendingStore.snapshot().lastError).not.toContain(rawUrl);
    expect(pendingStore.snapshot().notes?.find((note) => note.id === id)?.failed?.kind).toBe("rejected");
    const output = warnings.map((args) => args.join(" ")).join(" ");
    expect(output).toContain("TinyCloud upload rejected");
    expect(output).not.toContain("space.example");
    expect(output).not.toContain("private-token");
  } finally {
    console.warn = originalWarn;
    __setVoiceNotesForTests(original, { available: null });
    pendingStore.setAccount(null);
    await pendingStore.refresh(null);
  }
});

test("a real source-read failure is reported as non-retryable source with its message intact", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "off",
      identifySpeakers: false, uploadAudio: true });
    const { id } = await fake.plugin.start();
    await fake.plugin.stop();
    const readAudioChunk = fake.plugin.readAudioChunk.bind(fake.plugin);
    fake.plugin.readAudioChunk = (async (options: Parameters<typeof readAudioChunk>[0]) => {
      if (options.id === id) throw new Error("device source unavailable");
      return readAudioChunk(options);
    }) as typeof fake.plugin.readAudioChunk;
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh(null);
    await createVoiceNotePipeline(tcw, { retryDelaysMs: [] }).reconcileAll({
      did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration(),
    });
    expect(pendingStore.snapshot().notes?.find((note) => note.id === id)?.failed).toMatchObject({
      kind: "source", message: expect.stringContaining("device source unavailable"),
    });
  } finally {
    __setVoiceNotesForTests(original, { available: null });
    pendingStore.setAccount(null);
    await pendingStore.refresh(null);
  }
});

test("upload state starts before the first part completes and survives relist and in-flight callers", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  let releasePart!: () => void;
  let enteredPart!: () => void;
  const partGate = new Promise<void>((resolve) => { releasePart = resolve; });
  const partStarted = new Promise<void>((resolve) => { enteredPart = resolve; });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "off",
      identifySpeakers: false, uploadAudio: true });
    await fake.plugin.start();
    const recording = await fake.plugin.stop();
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh(null);
    const put = tcw.kv.put.bind(tcw.kv);
    tcw.kv.put = (async (key, value, options) => {
      if (key.includes("/audio/") && key.includes("/p/")) { enteredPart(); await partGate; }
      return put(key, value, options);
    }) as typeof tcw.kv.put;
    const ctx = { did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() };
    const ownerRun = createVoiceNotePipeline(tcw, { retryDelaysMs: [] }).process(ctx, recording.id);
    await partStarted;
    expect(pendingStore.snapshot().uploadingId).toBe(recording.id);
    expect(pendingStore.snapshot().notes?.find((note) => note.id === recording.id)?.upload?.state).toBe("uploading");
    await pendingStore.refresh();
    expect(pendingStore.snapshot().notes?.find((note) => note.id === recording.id)?.upload?.state).toBe("uploading");
    const listed = (await fake.plugin.listPending()).recordings.find((note) => note.id === recording.id)!;
    expect(await saveNoteForAccount(tcw, ctx, listed)).toEqual({ kind: "in-flight" });
    expect(pendingStore.snapshot().uploadingId).toBe(recording.id);
    expect(pendingStore.snapshot().notes?.find((note) => note.id === recording.id)?.upload?.state).toBe("uploading");
    releasePart();
    await ownerRun;
    expect(pendingStore.snapshot().uploadingId).toBeNull();
  } finally {
    releasePart();
    __setVoiceNotesForTests(original, { available: null });
    pendingStore.setAccount(null);
    await pendingStore.refresh(null);
  }
});

test("reconcile publishes per-note upload progress and retrying state", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const states: Array<{ state: string; bytes: number; total: number }> = [];
  const activeIds: Array<string | null> = [];
  const unsubscribe = pendingStore.subscribe(() => {
    const upload = pendingStore.snapshot().notes?.[0]?.upload;
    if (upload) states.push(upload);
    if (pendingStore.snapshot().uploadingId) activeIds.push(pendingStore.snapshot().uploadingId);
  });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1,
      transcriber: "off", identifySpeakers: false, uploadAudio: true });
    const { id } = await fake.plugin.start();
    await fake.plugin.stop();
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh(null);
    const put = tcw.kv.put.bind(tcw.kv);
    let failedOnce = false;
    tcw.kv.put = (async (key, value, options) => {
      if (key.includes("/audio/") && key.includes("/p/") && !failedOnce) {
        failedOnce = true;
        return { ok: false, error: { code: "NETWORK_ERROR", message: "temporary network failure" } };
      }
      return put(key, value, options);
    }) as typeof tcw.kv.put;
    await createVoiceNotePipeline(tcw, { retryDelaysMs: [0] }).reconcileAll({
      did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration(),
    });
    expect(states.some((item) => item.state === "waiting")).toBe(true);
    expect(states.some((item) => item.state === "retrying")).toBe(true);
    expect(states.some((item) => item.state === "uploading" && item.total > 0 && item.bytes > 0)).toBe(true);
    expect(activeIds).toContain(id);
    expect(pendingStore.snapshot().uploadingId).toBeNull();
    expect(pendingStore.snapshot().notes?.some((note) => note.id === id)).toBe(false);
  } finally {
    unsubscribe();
    __setVoiceNotesForTests(original, { available: null });
    pendingStore.setAccount(null);
    await pendingStore.refresh(null);
  }
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

test("a never-settling audio KV put reports a visible timeout and clears Saving now state", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const account = { did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() };
  let putStarted!: () => void;
  const started = new Promise<void>((resolve) => { putStarted = resolve; });
  try {
    setVoiceNoteSaveDeadlineForTests(25);
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "off",
      identifySpeakers: false, uploadAudio: true });
    await fake.plugin.start();
    const recording = await fake.plugin.stop();
    tcw.kv.put = ((_key, _value, options) => {
      putStarted();
      return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }) as typeof tcw.kv.put;
    const pipeline = createVoiceNotePipeline(tcw, { saveRetryDelaysMs: [] });
    const reconcile = pipeline.reconcileAll(account);
    await started;
    expect(pendingStore.snapshot().running).toBe(true);
    await reconcile;
    expect(pendingStore.snapshot().running).toBe(false);
    expect(pendingStore.snapshot().lastError).toContain("Saving to your TinyCloud space is slow");
    expect(pendingStore.snapshot().notes?.find((note) => note.id === recording.id)?.failed?.kind).toBe("timeout");
    // The disabled={saving} condition is now false, so Save now is enabled again.
  } finally {
    setVoiceNoteSaveDeadlineForTests(null);
    __setVoiceNotesForTests(original, { available: null });
  }
});

test("a lane timeout is retrying before its final failed attempt", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await ensureVoiceNoteIdentity(tcw);
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "off",
      identifySpeakers: false, uploadAudio: true });
    const started = await fake.plugin.start();
    await fake.plugin.stop();
    const next = await fake.plugin.start();
    await fake.plugin.stop();
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh();
    const put = tcw.kv.put.bind(tcw.kv);
    tcw.kv.put = ((key, value, options) => key.includes(started.id) && key.includes("/p/")
      ? new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
      : put(key, value, options)) as typeof tcw.kv.put;
    setVoiceNoteSaveDeadlineForTests(10);
    const running = createVoiceNotePipeline(tcw, { retryDelaysMs: [], saveRetryDelaysMs: [80] })
      .reconcileAll({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() });
    for (let turn = 0; turn < 100 && !pendingStore.snapshot().notes?.find((note) => note.id === started.id)?.retryAt; turn++)
      await Bun.sleep(1);
    const waiting = pendingStore.snapshot().notes?.find((note) => note.id === started.id);
    expect(waiting?.retryAt).toBeGreaterThan(Date.now());
    expect(waiting?.failed).toBeUndefined();
    await running;
    expect((await fake.plugin.listPending()).recordings.find((note) => note.id === next.id)?.ledger?.audio.state).toBe("saved");
    expect(pendingStore.snapshot().notes?.find((note) => note.id === started.id)?.failed).toBeUndefined();
    expect(pendingStore.snapshot().notes?.find((note) => note.id === started.id)?.retryAt).toBeGreaterThan(Date.now());
    for (let turn = 0; turn < 150 && pendingStore.snapshot().notes?.find((note) => note.id === started.id)?.failed?.kind !== "timeout"; turn++)
      await Bun.sleep(1);
    expect(pendingStore.snapshot().notes?.find((note) => note.id === started.id)?.failed?.kind).toBe("timeout");
  } finally {
    setVoiceNoteSaveDeadlineForTests(null);
    __setVoiceNotesForTests(original, { available: null });
  }
});

test("a real audio KV failure with meta.status 500 is reported as server", async () => {
  const original = VoiceNotes;
  const { tcw } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const put = tcw.kv.put.bind(tcw.kv);
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "off",
      identifySpeakers: false, uploadAudio: true });
    await fake.plugin.start();
    const recording = await fake.plugin.stop();
    tcw.kv.put = (async (key, value, options) => key.includes("/audio/")
      ? { ok: false, error: { code: "KV_ERROR", message: "The storage service rejected this write", meta: { status: 500 } } }
      : put(key, value, options)) as typeof tcw.kv.put;
    pendingStore.setAccount(tcw.did);
    await pendingStore.refresh(null);
    await createVoiceNotePipeline(tcw, { retryDelaysMs: [] }).reconcileAll({
      did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration(),
    });
    expect(pendingStore.snapshot().notes?.find((note) => note.id === recording.id)?.failed).toMatchObject({
      kind: "server", message: expect.stringContaining("The storage service rejected this write"),
    });
  } finally {
    __setVoiceNotesForTests(original, { available: null });
    pendingStore.setAccount(null);
    await pendingStore.refresh(null);
  }
});

test("a late part put settles before retry writes and retry commits one complete save", async () => {
  const original = VoiceNotes;
  const { tcw, sqlite, values } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  let resolveLate!: (result: Awaited<ReturnType<typeof tcw.kv.put>>) => void;
  let partWrites = 0;
  let rowId = "";
  try {
    setVoiceNoteSaveDeadlineForTests(25);
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "off",
      identifySpeakers: false, uploadAudio: true });
    const recording = await fake.plugin.start();
    rowId = recording.id;
    await fake.plugin.stop();
    const partKey = `${voiceNoteAudioKvKey(recording.id)}/p/000000`;
    const manifestKey = `${voiceNoteAudioKvKey(recording.id)}/manifest`;
    const put = tcw.kv.put.bind(tcw.kv);
    tcw.kv.put = ((key: string, value: unknown, options: { ifNoneMatch?: string; signal?: AbortSignal }) => {
      if (key === partKey) {
        partWrites++;
        return new Promise((resolve) => { resolveLate = (result) => {
          values.set(key, "late part committed");
          resolve(result);
        }; }) as ReturnType<typeof put>;
      }
      return put(key, value as never, options);
    }) as typeof tcw.kv.put;
    const pipeline = createVoiceNotePipeline(tcw, { saveRetryDelaysMs: [] });
    const ctx = { did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() };
    await pipeline.reconcileAll(ctx);
    expect(pendingStore.snapshot().lastError).toContain("Saving to your TinyCloud space is slow");
    expect(partWrites).toBe(1);
    const retry = pipeline.reconcileAll(ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(partWrites).toBe(1);
    expect(values.has(manifestKey)).toBe(false);
    resolveLate({ ok: true, data: {} } as Awaited<ReturnType<typeof tcw.kv.put>>);
    await retry;
    expect(partWrites).toBe(1);
    expect(values.has(manifestKey)).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM connector_meeting WHERE source_id = ? AND source = 'exo-voice-note'").get(rowId))
      .toMatchObject({ n: 1 });
    const ledger = (await fake.plugin.listPending()).recordings.find((note) => note.id === rowId)?.ledger;
    expect(ledger?.audio.state).toBe("saved");
  } finally {
    setVoiceNoteSaveDeadlineForTests(null);
    __setVoiceNotesForTests(original, { available: null });
  }
});

test("reconciling an already-saved note does not set the user-visible running state", async () => {
  const original = VoiceNotes;
  const { tcw, values } = space();
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "off", identifySpeakers: false });
    const { id } = await fake.plugin.start();
    await fake.plugin.stop();
    const note = (await fake.plugin.listPending()).recordings.find((recording) => recording.id === id)!;
    await createVoiceNoteRow(tcw, note, "Saved note");
    await saveNote(id, "# Local Markdown ahead of the space");
    await fake.plugin.updateLedger({ id, did: tcw.did, rev: note.rev ?? 0,
      patch: { audio: { state: "saved", rowId: `vn-${id}`, at: Date.now() } } });
    const pipeline = createVoiceNotePipeline(tcw);
    await pipeline.reconcileAll({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() });
    expect(pendingStore.snapshot().running).toBe(false);
    expect(values.get(voiceNoteMarkdownKvKey(id))).toContain("Local Markdown ahead of the space");
  } finally { __setVoiceNotesForTests(original, { available: null }); }
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

// A window stub that records listeners, so a test can fire the foreground events the saver subscribes to.
function foregroundHarness() {
  const listeners = new Map<string, Set<() => void>>();
  function hostNode(): unknown {
    return new Proxy(function () {}, { get: (_target, key) => key === "nodeType" ? 1 : key === "ownerDocument" ? documentStub
      : key === "style" ? {} : key === "firstChild" || key === "parentNode" ? null : () => hostNode(), set: () => true });
  }
  const documentStub = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {},
    createElement: () => hostNode(), createTextNode: () => hostNode() };
  const windowStub = { HTMLIFrameElement: class {}, document: documentStub,
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener); },
    setTimeout, clearTimeout };
  const root = createRoot({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: documentStub, textContent: "",
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, insertBefore() {} } as unknown as HTMLElement);
  return { windowStub, root, fire(type: string) { for (const listener of [...listeners.get(type) ?? []]) listener(); } };
}

describe.serial("storage recovery wakes", () => {
test("an on-device transcript held by storage is retried by a foreground focus once space is back", async () => {
  const original = VoiceNotes;
  const previousWindow = globalThis.window;
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const previousStt = OnDeviceStt;
  __setOnDeviceSttForTests({ addListener: async () => ({ remove: async () => {} }) } as unknown as OnDeviceSttPlugin);
  const fake = createFakeVoiceNotes();
  const { tcw } = space();
  let spaceFull = true;
  let releaseReconcile = (): void => {};
  const reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
  const originalDb = tcw.sql.db.bind(tcw.sql);
  tcw.sql.db = ((name: string) => ({ ...originalDb(name), execute: async (statement: string, params: unknown[] = []) =>
    spaceFull && statement.includes("INSERT INTO voice_note_transcript")
      ? { ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "Storage is full" } }
      : originalDb(name).execute(statement, params as never[]),
  })) as typeof tcw.sql.db;
  __setVoiceNotesForTests(fake.plugin, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
  await ensureSchema(tcw);
  await fake.plugin.start();
  const recording = await fake.plugin.stop();
  await createVoiceNoteRow(tcw, { id: recording.id, startedAt: 0, durationMs: 1_000, mimeType: "audio/mpeg",
    sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Held note");
  fake.plugin.getTranscript = async () => ({ transcript: {
    version: 1, noteId: recording.id, transcriber: "on-device", rev: 1,
    engine: "apple-speech", model: null, language: "en", outcome: "transcribed",
    diarized: false, segments: [{ start: 0, end: 1000, text: "Held words", speaker: null }],
    createdAt: "2026-10-03T10:00:00.000Z",
  } });
  const harness = foregroundHarness();
  Reflect.set(globalThis, "window", harness.windowStub);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  try {
    await syncOnDeviceTranscript(tcw, { id: recording.id, ledger: { audio: { state: "saved" } } });
    expect(await readTranscriptCommit(tcw, recording.id)).toBeFalsy();
    // Mounting while space is still full: the mount reconcile stays parked, so held transcript recovery must not wait behind it.
    const parkedPipeline = createVoiceNotePipeline(tcw);
    const reconcile = parkedPipeline.reconcileAll.bind(parkedPipeline);
    // Parks the mount reconcile in flight, so the foreground event arrives while that run is still awaiting.
    parkedPipeline.reconcileAll = async (ctx, trigger, onSaved) => { await reconcileGate; return reconcile(ctx, trigger, onSaved); };
    await act(async () => harness.root.render(createElement(PendingVoiceNotesSaver,
      { tcw, pipeline: parkedPipeline, backendUrl: "", sessionStore: {} as never })));
    await settle();
    expect(await readTranscriptCommit(tcw, recording.id)).toBeFalsy();
    spaceFull = false;
    harness.fire("focus");
    // The audio put is still parked: the foreground event alone must finish the held transcript.
    for (let i = 0; i < 100 && !(await readTranscriptCommit(tcw, recording.id)); i++) await settle();
    expect(await readTranscriptCommit(tcw, recording.id)).toMatchObject({ rev: 1 });
  } finally {
    releaseReconcile();
    await act(async () => harness.root.unmount());
    __setOnDeviceSttForTests(previousStt);
    __setVoiceNotesForTests(original, { available: null });
    Reflect.set(globalThis, "window", previousWindow);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    reportStorageWriteSucceeded();
  }
});

test("a focus alone saves queued audio once space is restored after a full-space mount pass", async () => {
  const original = VoiceNotes;
  const previousWindow = globalThis.window;
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const previousStt = OnDeviceStt;
  __setOnDeviceSttForTests({ addListener: async () => ({ remove: async () => {} }) } as unknown as OnDeviceSttPlugin);
  const fake = createFakeVoiceNotes();
  const { tcw } = space();
  let spaceFull = true;
  const put = tcw.kv.put.bind(tcw.kv);
  tcw.kv.put = (async (key: string, value: string, options?: { ifNoneMatch?: string }) => spaceFull && key.includes("/audio/")
    ? { ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "Storage is full" } }
    : put(key, value, options)) as typeof tcw.kv.put;
  __setVoiceNotesForTests(fake.plugin, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "on-device",
    identifySpeakers: false, uploadAudio: true });
  await ensureSchema(tcw);
  await fake.plugin.start();
  const recording = await fake.plugin.stop();
  const events: unknown[] = [];
  const off = captureEvents.on("library-changed", (event) => { events.push(event); });
  const harness = foregroundHarness();
  Reflect.set(globalThis, "window", harness.windowStub);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  try {
    await act(async () => harness.root.render(createElement(PendingVoiceNotesSaver,
      { tcw, pipeline: createVoiceNotePipeline(tcw), backendUrl: "", sessionStore: {} as never })));
    await settle();
    expect(events).toEqual([]);
    const queued = (await fake.plugin.listPending()).recordings.find((note) => note.id === recording.id);
    expect(queued).toBeDefined();
    expect(queued?.ledger?.audio.state).not.toBe("saved");
    spaceFull = false;
    harness.fire("focus");
    for (let i = 0; i < 100 && events.length === 0; i++) await settle();
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: recording.id }]);
  } finally {
    off();
    await act(async () => harness.root.unmount());
    __setOnDeviceSttForTests(previousStt);
    __setVoiceNotesForTests(original, { available: null });
    Reflect.set(globalThis, "window", previousWindow);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    reportStorageWriteSucceeded();
  }
});

// An ordinary successful write outside the saver: the only signal that storage has room again, with no focus event.
async function externalWrite(tcw: TinyCloudWeb): Promise<void> {
  const result = await trackStorageWrites(tcw.sql.db(CONNECTORS_SQL_DB_NAME))
    .execute("DELETE FROM connector_meeting WHERE source_id = ?", ["external-write"]);
  expect(result).toMatchObject({ ok: true });
}
function watchReconciles(pipeline: VoiceNotePipeline) {
  let completed = 0;
  const waiting = new Map<number, (() => void)[]>();
  const reconcile = pipeline.reconcileAll.bind(pipeline);
  pipeline.reconcileAll = async (...args) => {
    const result = await reconcile(...args);
    completed++;
    for (const [target, resolvers] of waiting) {
      if (target > completed) continue;
      waiting.delete(target);
      for (const resolve of resolvers) resolve();
    }
    return result;
  };
  return {
    waitFor(target: number): Promise<void> {
      if (completed >= target) return Promise.resolve();
      return new Promise((resolve) => waiting.set(target, [...(waiting.get(target) ?? []), resolve]));
    },
  };
}


async function settleRecovery(): Promise<void> {
  await act(async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); });
}

test("an on-device transcript held by storage resumes on an external successful write, with no focus event", async () => {
  const original = VoiceNotes;
  const previousWindow = globalThis.window;
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const previousStt = OnDeviceStt;
  __setOnDeviceSttForTests({ addListener: async () => ({ remove: async () => {} }) } as unknown as OnDeviceSttPlugin);
  const fake = createFakeVoiceNotes();
  const { tcw } = space();
  let spaceFull = true;
  let committedWrites = 0;
  const originalDb = tcw.sql.db.bind(tcw.sql);
  tcw.sql.db = ((name: string) => ({ ...originalDb(name), execute: async (statement: string, params: unknown[] = []) => {
    if (spaceFull && statement.includes("INSERT INTO voice_note_transcript")) return { ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "Storage is full" } };
    const result = await originalDb(name).execute(statement, params as never[]);
    if (result.ok && statement.includes("INSERT INTO voice_note_transcript")) committedWrites++;
    return result;
  } })) as typeof tcw.sql.db;
  __setVoiceNotesForTests(fake.plugin, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
  await ensureSchema(tcw);
  await fake.plugin.start();
  const recording = await fake.plugin.stop();
  await createVoiceNoteRow(tcw, { id: recording.id, startedAt: 0, durationMs: 1_000, mimeType: "audio/mpeg",
    sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Held note");
  fake.plugin.getTranscript = async () => ({ transcript: {
    version: 1, noteId: recording.id, transcriber: "on-device", rev: 1,
    engine: "apple-speech", model: null, language: "en", outcome: "transcribed",
    diarized: false, segments: [{ start: 0, end: 1000, text: "Held words", speaker: null }],
    createdAt: "2026-10-03T10:00:00.000Z",
  } });
  const harness = foregroundHarness();
  Reflect.set(globalThis, "window", harness.windowStub);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  try {
    await syncOnDeviceTranscript(tcw, { id: recording.id, ledger: { audio: { state: "saved" } } });
    expect(await readTranscriptCommit(tcw, recording.id)).toBeFalsy();
    const pipeline = createVoiceNotePipeline(tcw);
    const reconciles = watchReconciles(pipeline);
    await act(async () => harness.root.render(createElement(PendingVoiceNotesSaver,
      { tcw, pipeline, backendUrl: "", sessionStore: {} as never })));
    await reconciles.waitFor(1);
    await settle();
    spaceFull = false;
    await settle();
    // Capacity is back but nothing has written since: the held transcript stays put until an external write.
    expect(await readTranscriptCommit(tcw, recording.id)).toBeFalsy();
    await externalWrite(tcw);
    await reconciles.waitFor(2);
    await settle();
    expect(await readTranscriptCommit(tcw, recording.id)).toMatchObject({ rev: 1 });
    expect(committedWrites).toBe(1);
  } finally {
    await act(async () => harness.root.unmount());
    __setOnDeviceSttForTests(previousStt);
    __setVoiceNotesForTests(original, { available: null });
    Reflect.set(globalThis, "window", previousWindow);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    reportStorageWriteSucceeded();
  }
});

test("queued audio uploads once on an external successful write, with no focus event", async () => {
  const original = VoiceNotes;
  const previousWindow = globalThis.window;
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const previousStt = OnDeviceStt;
  __setOnDeviceSttForTests({ addListener: async () => ({ remove: async () => {} }) } as unknown as OnDeviceSttPlugin);
  const fake = createFakeVoiceNotes();
  const { tcw } = space();
  let spaceFull = true;
  let audioSaved = 0;
  const put = tcw.kv.put.bind(tcw.kv);
  tcw.kv.put = (async (key: string, value: string, options?: { ifNoneMatch?: string }) => {
    if (spaceFull && key.includes("/audio/")) return { ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "Storage is full" } };
    const result = await put(key, value, options);
    // Each upload writes its parts, then the manifest last: the manifest marks one completed upload.
    if (key.endsWith("/manifest") && result.ok) audioSaved++;
    return result;
  }) as typeof tcw.kv.put;
  __setVoiceNotesForTests(fake.plugin, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "on-device",
    identifySpeakers: false, uploadAudio: true });
  await ensureSchema(tcw);
  await fake.plugin.start();
  const recording = await fake.plugin.stop();
  const events: unknown[] = [];
  const off = captureEvents.on("library-changed", (event) => { events.push(event); });
  const harness = foregroundHarness();
  Reflect.set(globalThis, "window", harness.windowStub);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  try {
    const pipeline = createVoiceNotePipeline(tcw);
    const reconciles = watchReconciles(pipeline);
    await act(async () => harness.root.render(createElement(PendingVoiceNotesSaver,
      { tcw, pipeline, backendUrl: "", sessionStore: {} as never })));
    await reconciles.waitFor(1);
    await settle();
    expect(events).toEqual([]);
    spaceFull = false;
    await settle();
    await settle();
    // Capacity is back but nothing has written since: the queued audio stays queued until an external write.
    expect(events).toEqual([]);
    expect(audioSaved).toBe(0);
    await externalWrite(tcw);
    await reconciles.waitFor(2);
    await settle();
    expect(events).toEqual([{ source: VOICE_NOTE_SOURCE, sourceId: recording.id }]);
    expect(audioSaved).toBe(1);
  } finally {
    off();
    await act(async () => harness.root.unmount());
    __setOnDeviceSttForTests(previousStt);
    __setVoiceNotesForTests(original, { available: null });
    Reflect.set(globalThis, "window", previousWindow);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    reportStorageWriteSucceeded();
  }
});

test("audio that never fits: each external successful write runs one recovery pass, and that pass's own writes do not re-trigger it", async () => {
  const original = VoiceNotes;
  const previousWindow = globalThis.window;
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const previousStt = OnDeviceStt;
  __setOnDeviceSttForTests({ addListener: async () => ({ remove: async () => {} }) } as unknown as OnDeviceSttPlugin);
  const fake = createFakeVoiceNotes();
  const { tcw } = space();
  let audioAttempts = 0;
  const put = tcw.kv.put.bind(tcw.kv);
  tcw.kv.put = (async (key: string, value: string, options?: { ifNoneMatch?: string }) => {
    if (/\/audio\/[^/]+\/p\/\d+$/.test(key)) {
      audioAttempts++;
      return { ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "Storage is full" } };
    }
    return put(key, value, options);
  }) as typeof tcw.kv.put;
  __setVoiceNotesForTests(fake.plugin, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "on-device",
    identifySpeakers: false, uploadAudio: true });
  await ensureSchema(tcw);
  await fake.plugin.start();
  await fake.plugin.stop();
  const harness = foregroundHarness();
  Reflect.set(globalThis, "window", harness.windowStub);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  try {
    const pipeline = createVoiceNotePipeline(tcw);
    const reconciles = watchReconciles(pipeline);
    await act(async () => harness.root.render(createElement(PendingVoiceNotesSaver,
      { tcw, pipeline, backendUrl: "", sessionStore: {} as never })));
    await reconciles.waitFor(1);
    await settle();
    expect(audioAttempts).toBe(1);
    for (let i = 0; i < 3; i++) {
      await externalWrite(tcw);
      await reconciles.waitFor(i + 2);
      await settle();
      expect(audioAttempts).toBe(i + 2);
    }
  } finally {
    await act(async () => harness.root.unmount());
    __setOnDeviceSttForTests(previousStt);
    __setVoiceNotesForTests(original, { available: null });
    Reflect.set(globalThis, "window", previousWindow);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    reportStorageWriteSucceeded();
  }
});

test("queued audio beside a text-only note uploads once on an external successful write, with no focus event", async () => {
  const original = VoiceNotes;
  const previousWindow = globalThis.window;
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const previousStt = OnDeviceStt;
  __setOnDeviceSttForTests({ addListener: async () => ({ remove: async () => {} }) } as unknown as OnDeviceSttPlugin);
  const fake = createFakeVoiceNotes();
  const { tcw } = space();
  let spaceFull = true;
  let audioSaved = 0;
  const put = tcw.kv.put.bind(tcw.kv);
  tcw.kv.put = (async (key: string, value: string, options?: { ifNoneMatch?: string }) => {
    if (spaceFull && key.includes("/audio/")) return { ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "Storage is full" } };
    const result = await put(key, value, options);
    if (key.endsWith("/manifest") && result.ok) audioSaved++;
    return result;
  }) as typeof tcw.kv.put;
  __setVoiceNotesForTests(fake.plugin, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "on-device",
    identifySpeakers: false, uploadAudio: true });
  await ensureSchema(tcw);
  await fake.plugin.start();
  await fake.plugin.stop();
  // A text-only note saves fine while space is full: its successful row writes are what used to hide the audio failure.
  await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "on-device",
    identifySpeakers: false, uploadAudio: false });
  await fake.plugin.start();
  await fake.plugin.stop();
  const harness = foregroundHarness();
  Reflect.set(globalThis, "window", harness.windowStub);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  try {
    const pipeline = createVoiceNotePipeline(tcw);
    const reconciles = watchReconciles(pipeline);
    await act(async () => harness.root.render(createElement(PendingVoiceNotesSaver,
      { tcw, pipeline, backendUrl: "", sessionStore: {} as never })));
    await reconciles.waitFor(1);
    expect(audioSaved).toBe(0);
    spaceFull = false;
    await settle();
    await settle();
    // Nothing has written since the failure: no wake, so the queued audio stays queued.
    expect(audioSaved).toBe(0);
    await externalWrite(tcw);
    await reconciles.waitFor(2);
    expect(audioSaved).toBe(1);
  } finally {
    await act(async () => harness.root.unmount());
    __setOnDeviceSttForTests(previousStt);
    __setVoiceNotesForTests(original, { available: null });
    Reflect.set(globalThis, "window", previousWindow);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    reportStorageWriteSucceeded();
  }
});
test("a held on-device transcript commits once when an external write lands during a parked reconcile and a later one follows", async () => {
  const original = VoiceNotes;
  const previousWindow = globalThis.window;
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const previousStt = OnDeviceStt;
  __setOnDeviceSttForTests({ addListener: async () => ({ remove: async () => {} }) } as unknown as OnDeviceSttPlugin);
  const fake = createFakeVoiceNotes();
  const { tcw } = space();
  let spaceFull = true;
  let committedWrites = 0;
  const originalDb = tcw.sql.db.bind(tcw.sql);
  tcw.sql.db = ((name: string) => ({ ...originalDb(name), execute: async (statement: string, params: unknown[] = []) => {
    if (spaceFull && statement.includes("INSERT INTO voice_note_transcript")) return { ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED", message: "Storage is full" } };
    const result = await originalDb(name).execute(statement, params as never[]);
    if (result.ok && statement.includes("INSERT INTO voice_note_transcript")) committedWrites++;
    return result;
  } })) as typeof tcw.sql.db;
  __setVoiceNotesForTests(fake.plugin, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: tcw.did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
  await ensureSchema(tcw);
  await fake.plugin.start();
  const recording = await fake.plugin.stop();
  await createVoiceNoteRow(tcw, { id: recording.id, startedAt: 0, durationMs: 1_000, mimeType: "audio/mpeg",
    sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, "Held note");
  fake.plugin.getTranscript = async () => ({ transcript: {
    version: 1, noteId: recording.id, transcriber: "on-device", rev: 1,
    engine: "apple-speech", model: null, language: "en", outcome: "transcribed",
    diarized: false, segments: [{ start: 0, end: 1000, text: "Held words", speaker: null }],
    createdAt: "2026-10-03T10:00:00.000Z",
  } });
  // The mount pass parks in its reconcile after its held probe has already failed against the full space.
  let releaseReconcile!: () => void;
  const reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
  const parkedPipeline = createVoiceNotePipeline(tcw);
  const reconcile = parkedPipeline.reconcileAll.bind(parkedPipeline);
  parkedPipeline.reconcileAll = async (ctx, trigger, onSaved) => {
    await reconcileGate;
    return reconcile(ctx, trigger, onSaved);
  };
  const harness = foregroundHarness();
  Reflect.set(globalThis, "window", harness.windowStub);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  try {
    await syncOnDeviceTranscript(tcw, { id: recording.id, ledger: { audio: { state: "saved" } } });
    expect(await readTranscriptCommit(tcw, recording.id)).toBeFalsy();
    await act(async () => harness.root.render(createElement(PendingVoiceNotesSaver,
      { tcw, pipeline: parkedPipeline, backendUrl: "", sessionStore: {} as never })));
    await settle();
    // Lands while the mount pass is in flight: no wake, and the pass does not replay it.
    await externalWrite(tcw);
    spaceFull = false;
    releaseReconcile();
    await settleRecovery();
    expect(await readTranscriptCommit(tcw, recording.id)).toBeFalsy();
    // The next successful write after the pass settles is the one that wakes recovery.
    await externalWrite(tcw);
    await settleRecovery();
    await settle();
    expect(await readTranscriptCommit(tcw, recording.id)).toMatchObject({ rev: 1 });
    expect(committedWrites).toBe(1);
  } finally {
    releaseReconcile();
    await act(async () => harness.root.unmount());
    __setOnDeviceSttForTests(previousStt);
    __setVoiceNotesForTests(original, { available: null });
    Reflect.set(globalThis, "window", previousWindow);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    reportStorageWriteSucceeded();
  }
});

});
});
