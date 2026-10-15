// Notes that reach the space through reconcileAll (relaunch, the sign-in claim, Save now) are handed
// to the transcriber once, with their committed options, exactly as a note saved on Stop is.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "@/capture/captureEvents";

import { memoryHoldStore } from "@/harness/memoryHoldStore";
import { CONNECTORS_SQL_DB_NAME } from "../connectors/connectorStore";
import { createPrivateCloudApi, PrivateCloudError, type PrivateCloudCapabilities } from "../privateCloud";
import type { SessionStore } from "@tinyboilerplate/client";
import { advanceAccountGeneration, currentAccountGeneration } from "./accountContext";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes, type LocalTranscript, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { createVoiceNotePipeline } from "./voiceNotePipeline";
import { saveNote } from "./recordingNotes";
import { voiceNoteAudioKvKey, voiceNoteMarkdownKvKey } from "./voiceNoteStore";
import { pendingStore, whenVoiceNoteSavesIdle } from "./recorderSaves";
import { VoiceNoteSaveTimeout } from "./saveDeadline";
import { createVoiceNoteRecorderController } from "@/capture/recorder/voiceNoteRecorderController";
import { createVoiceNoteCloud, createVoiceNoteTranscriber, transcribeSavedNote, type VoiceNoteCloud, type VoiceNoteTranscriber } from "./voiceNoteTranscription";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { onDeviceTranscriptSyncState, recordOnDeviceTranscript, subscribeOnDeviceTranscriptSync, syncOnDeviceTranscript } from "./onDeviceTranscriber";
import { createVoiceNoteRow, resolveVoiceNoteRow } from "./voiceNoteRows";
import { readVoiceNotePendingSnapshot } from "./voiceNotePendingSnapshot";

const CAPS: PrivateCloudCapabilities = { max_bytes: 120_960_000, max_duration_seconds: 7_777, content_types: ["audio/wav"], admission: "open" };
const original = VoiceNotes;
afterEach(() => __setVoiceNotesForTests(original, { available: null }));

let count = 0;
function space() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = `did:test:reconcile-transcribe-${++count}`;
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
  return { tcw: { did, spaceId: did, sql, kv } as unknown as TinyCloudWeb, values };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function transcriberWithRuns() {
  const cloud: VoiceNoteCloud = {
    capabilities: async () => CAPS,
    pendingSourceIds: () => [],
    hasRemoteJob: () => false,
    holdTranscript: () => {},
    heldTranscript: () => null,
    transcribe: async () => { throw new Error("runNote is faked"); },
    finish: async () => {},
    releaseUnsent: async () => {},
  };
  const runs: string[] = [];
  const fail: Record<string, (err: unknown) => void> = {};
  const finish: Record<string, () => void> = {};
  const transcriber = createVoiceNoteTranscriber({
    cloud,
    consent: { get: () => true, set: () => {} },
    tcw: () => ({}) as TinyCloudWeb,
    holds: memoryHoldStore(),
    sleep: async () => {},
    runNote: (args) => new Promise((resolve, reject) => { runs.push(args.sourceId); fail[args.sourceId] = reject; finish[args.sourceId] = () => resolve("transcribed"); }),
  });
  return { transcriber, runs, fail, finish };
}

async function setup(transcriberOption: "off" | "on-device" | "private-cloud",
  transcriptRetryDelaysMs?: readonly number[]) {
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const { tcw, values } = space();
  const pipeline = createVoiceNotePipeline(tcw, { retryDelaysMs: [], transcriptPassCooldownMs: 0, transcriptRetryDelaysMs });
  const ctx = () => ({ did: tcw.did, spaceId: tcw.spaceId ?? tcw.did, generation: currentAccountGeneration() });
  let transitionGen = 0;
  const signInAs = (accountDid: string, transcriber = transcriberOption) =>
    fake.plugin.setCaptureDefaults({ accountDid, transitionGen: ++transitionGen, transcriber, identifySpeakers: false, uploadAudio: true });
  const recordFor = async (accountDid: string) => {
    await signInAs(accountDid);
    await fake.plugin.start();
    return fake.plugin.stop();
  };
  const t = transcriberWithRuns();
  await t.transcriber.check();
  const handOver = (generation = currentAccountGeneration()) => (note: VoiceNoteRecording) =>
    transcribeSavedNote(t.transcriber, note, () => generation === currentAccountGeneration());
  return { fake, tcw, values, pipeline, ctx, recordFor, signInAs, handOver, ...t };
}

describe("a note saved by reconcileAll is handed to the transcriber", () => {
  test("Private still starts for a note whose audio upload was off", async () => {
    const s = await setup("private-cloud");
    await s.signInAs(s.tcw.did);
    await s.fake.plugin.start({ uploadAudio: false });
    const note = await s.fake.plugin.stop();
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    expect(s.runs).toEqual([note.id]);
    const row = await s.tcw.sql.db(CONNECTORS_SQL_DB_NAME).query("SELECT metadata FROM connector_meeting WHERE source_id = ?", [note.id]);
    expect(row.ok).toBe(true);
    if (row.ok) expect(JSON.parse(String(row.data.rows[0]?.[0])).audio.stored).toBe(false);
    const audioBase = voiceNoteAudioKvKey(note.id);
    expect([...s.values.keys()].some((key) => key === audioBase || key.startsWith(`${audioBase}/p/`) || key === `${audioBase}/manifest`)).toBe(false);
  });
  test("on-device notes with audio upload off save a metadata row without audio and mark the ledger saved", async () => {
    const s = await setup("on-device");
    await s.signInAs(s.tcw.did, "on-device");
    await s.fake.plugin.start({ uploadAudio: false });
    const note = await s.fake.plugin.stop();
    await saveNote(note.id, "# Synthetic local note");
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());

    const row = await s.tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(
      "SELECT metadata FROM connector_meeting WHERE source_id = ?", [note.id]);
    expect(row.ok).toBe(true);
    if (row.ok) expect(JSON.parse(String(row.data.rows[0]?.[0])).audio.stored).toBe(false);
    const audioBase = voiceNoteAudioKvKey(note.id);
    expect(s.values.has(voiceNoteMarkdownKvKey(note.id))).toBe(true);
    expect([...s.values.keys()].some((key) => key === audioBase || key.startsWith(`${audioBase}/p/`)
      || key === `${audioBase}/manifest`)).toBe(false);
    expect((await s.fake.plugin.listPending()).recordings.find((item) => item.id === note.id)?.ledger?.audio.state).toBe("saved");
  });
  test("a Private note left on the phone and saved after sign-in gets one Private job, and relaunching does not send it again", async () => {
    const s = await setup("private-cloud");
    const note = await s.recordFor(s.tcw.did);
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    expect(s.runs).toEqual([note.id]);
    expect(s.transcriber.snapshot().jobs.get(note.id)?.kind).toBe("active");
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    expect(s.runs).toEqual([note.id]);
  });

  test("Save now gets one Private job", async () => {
    const s = await setup("private-cloud");
    const note = await s.recordFor(s.tcw.did);
    await s.pipeline.reconcileAll(s.ctx(), "manual", s.handOver());
    await tick();
    expect(s.runs).toEqual([note.id]);
  });

  test("an Off note gets none", async () => {
    const s = await setup("off");
    const note = await s.recordFor(s.tcw.did);
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    expect((await s.fake.plugin.listPending()).recordings.find((entry) => entry.id === note.id)?.ledger?.audio.state).toBe("saved");
    expect(s.runs).toEqual([]);
    expect(s.transcriber.snapshot().jobs.get(note.id)).toBeUndefined();
  });

  test("a Local note stays private without upload approval; a consented Local note is not sent to the cloud", async () => {
    const s = await setup("private-cloud");
    await s.fake.plugin.start({ uploadAudio: false });
    const signedOut = await s.fake.plugin.stop();
    expect(signedOut.owner).toBeNull();
    const cloud = await s.recordFor(s.tcw.did);
    await s.signInAs(s.tcw.did, "on-device");
    await s.fake.plugin.start();
    const onDevice = await s.fake.plugin.stop();
    expect(onDevice.options?.transcriber).toBe("on-device");
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    const states = (await s.fake.plugin.listPending()).recordings.map((entry) => [entry.id, entry.ledger?.audio.state]);
    expect(states).toContainEqual([signedOut.id, "saved"]);
    expect(states).toContainEqual([onDevice.id, "saved"]);
    expect(s.runs).toEqual([cloud.id]);
  });

  test("a note the recorder already handed over gets no second job, in either order", async () => {
    const s = await setup("private-cloud");
    const first = await s.recordFor(s.tcw.did);
    s.transcriber.noteSaved(first);
    await tick();
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    expect(s.runs).toEqual([first.id]);
    s.finish[first.id]!();
    await tick();

    const second = await s.recordFor(s.tcw.did);
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    s.transcriber.noteSaved(second);
    await tick();
    expect(s.runs).toEqual([first.id, second.id]);
  });

  test("a note whose job already failed is not sent again by a later hand-off; only Retry does that", async () => {
    const s = await setup("private-cloud");
    const note = await s.recordFor(s.tcw.did);
    s.transcriber.noteSaved(note);
    await tick();
    expect(s.runs).toEqual([note.id]);
    s.fail[note.id]!(new PrivateCloudError("service_busy", "busy"));
    await tick();
    expect(s.transcriber.snapshot().jobs.get(note.id)?.kind).toBe("failed");
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    s.transcriber.noteSaved(note);
    await tick();
    expect(s.runs).toEqual([note.id]);
    s.transcriber.transcribe(note.id);
    await tick();
    expect(s.runs).toEqual([note.id, note.id]);
  });

  test("another account's note gets nothing, and neither does a hand-off from a superseded generation", async () => {
    const s = await setup("private-cloud");
    const other = await s.recordFor("did:test:someone-else");
    await s.signInAs(s.tcw.did);
    const stale = s.handOver();
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", stale);
    await tick();
    expect((await s.fake.plugin.listPending()).recordings.find((entry) => entry.id === other.id)?.ledger?.audio.state).toBe("pending");
    expect(s.runs).toEqual([]);

    const mine = await s.recordFor(s.tcw.did);
    const handOver = s.handOver();
    advanceAccountGeneration();
    handOver(mine);
    await tick();
    expect(s.runs).toEqual([]);
  });
});

test("reconcileSavedDoneWithoutRenderedViewCommits", async () => {
  const s = await setup("on-device");
  const note = await s.recordFor(s.tcw.did);
  await s.pipeline.reconcileAll(s.ctx());
  const completed: LocalTranscript = {
    version: 2, noteId: note.id, transcriber: "on-device", rev: 1,
    engine: "apple-speech", model: null, language: "en", outcome: "transcribed", diarized: false,
    segments: [{ start: 0, end: 1000, text: "synthetic spoken note", speaker: null }],
    createdAt: "2026-10-15T00:00:00Z",
  };
  await s.fake.plugin.putTranscript!({ id: note.id, transcript: completed });
  const listPending = s.fake.plugin.listPending.bind(s.fake.plugin);
  __setVoiceNotesForTests({ ...s.fake.plugin, listPending: async () => ({
    recordings: (await listPending()).recordings.map((entry) => entry.id === note.id
      ? { ...entry, stt: { ...entry.stt!, state: "done" as const } } : entry),
  }) }, { available: true });
  await s.pipeline.reconcileAll(s.ctx());
  const commit = await readTranscriptCommit(s.tcw, note.id);
  expect(commit?.rev).toBe(1);
  const body = await s.tcw.kv.get(commit!.bodyKey);
  expect(body.ok && JSON.stringify(body.data.data)).toContain("synthetic spoken note");
});

test("overlapping reconciliation turns never inspect or sync the same revision concurrently", async () => {
  const s = await setup("on-device");
  const note = await s.recordFor(s.tcw.did);
  await s.pipeline.process(s.ctx(), note.id);
  await s.fake.plugin.putTranscript!({ id: note.id, transcript: {
    version: 2, noteId: note.id, transcriber: "on-device", rev: 1, engine: "apple-speech",
    model: null, language: "en", outcome: "no_speech", diarized: false, segments: [],
    createdAt: "2026-10-15T00:00:00Z",
  } });
  const listPending = s.fake.plugin.listPending.bind(s.fake.plugin);
  const getTranscript = s.fake.plugin.getTranscript.bind(s.fake.plugin);
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let reads = 0;
  __setVoiceNotesForTests({ ...s.fake.plugin,
    listPending: async () => ({ recordings: (await listPending()).recordings.map((entry) => entry.id === note.id
      ? { ...entry, stt: { ...entry.stt!, state: "done" as const } } : entry) }),
    getTranscript: async (args) => {
      reads++;
      if (reads === 1) { started.resolve(); await gate.promise; }
      return getTranscript(args);
    },
  }, { available: true });
  const first = s.pipeline.reconcileAll(s.ctx());
  await started.promise;
  const second = s.pipeline.reconcileAll(s.ctx());
  try {
    await tick();
    expect(reads).toBe(1);
  } finally { gate.resolve(); }
  await Promise.all([first, second]);
  expect((await readTranscriptCommit(s.tcw, note.id))?.rev).toBe(1);
  s.pipeline.cancelAll();
});

test("saved audio without a row waits for row resolution before attempting its transcript", async () => {
  const s = await setup("on-device");
  const note = await s.recordFor(s.tcw.did);
  const listPending = s.fake.plugin.listPending.bind(s.fake.plugin);
  await s.fake.plugin.putTranscript!({ id: note.id, transcript: {
    version: 2, noteId: note.id, transcriber: "on-device", rev: 1, engine: "apple-speech",
    model: null, language: "en", outcome: "no_speech", diarized: false, segments: [],
    createdAt: "2026-10-15T00:00:00Z",
  } });
  __setVoiceNotesForTests({ ...s.fake.plugin, listPending: async () => ({
    recordings: (await listPending()).recordings.map((entry) => entry.id === note.id
      ? { ...entry, ledger: { ...entry.ledger!, audio: { state: "saved" as const } },
        stt: { ...entry.stt!, state: "done" as const } } : entry),
  }) }, { available: true });
  await s.pipeline.reconcileAll(s.ctx());
  expect(onDeviceTranscriptSyncState(s.tcw, note.id)).toBeNull();
  const current = (await VoiceNotes.listPending()).recordings.find((entry) => entry.id === note.id)!;
  await createVoiceNoteRow(s.tcw, current, "Synthetic note", undefined, "ios");
  await s.pipeline.reconcileAll(s.ctx());
  expect((await readTranscriptCommit(s.tcw, note.id))?.rev).toBe(1);
  s.pipeline.cancelAll();
});

test("foreground scan discovers a repaired durable sidecar without a transcribed callback", async () => {
  const s = await setup("on-device");
  const repaired = await s.recordFor(s.tcw.did);
  await s.pipeline.process(s.ctx(), repaired.id);
  await s.fake.plugin.putTranscript!({ id: repaired.id, transcript: {
    version: 2, noteId: repaired.id, transcriber: "on-device", rev: 1, engine: "apple-speech",
    model: null, language: "en", outcome: "no_speech", diarized: false, segments: [],
    createdAt: "2026-10-15T00:00:00Z",
  } });
  const pending = await s.recordFor(s.tcw.did);
  const listPending = s.fake.plugin.listPending.bind(s.fake.plugin);
  const updateLedger = s.fake.plugin.updateLedger.bind(s.fake.plugin);
  let repairedOnDisk = false;
  __setVoiceNotesForTests({ ...s.fake.plugin,
    listPending: async () => ({ recordings: (await listPending()).recordings.map((entry) => entry.id === repaired.id
      ? { ...entry, stt: { ...entry.stt!, state: repairedOnDisk ? "done" as const : "running" as const } } : entry) }),
    updateLedger: async (args) => {
      const result = await updateLedger(args);
      if (args.id === pending.id) repairedOnDisk = true;
      return result;
    },
  }, { available: true });
  await s.pipeline.reconcileAll(s.ctx());
  expect(repairedOnDisk).toBe(true);
  expect((await readTranscriptCommit(s.tcw, repaired.id))?.rev).toBe(1);
  expect((await resolveVoiceNoteRow(s.tcw, repaired.id))?.metadata.transcription_outcome).toBe("no_speech");
  expect(onDeviceTranscriptSyncState(s.tcw, repaired.id)).toMatchObject({ state: "synced" });
  s.pipeline.cancelAll();
});

test("rowReceiptRefreshesSttAfterCASConflict", async () => {
  const s = await setup("on-device");
  await s.signInAs(s.tcw.did);
  await s.fake.plugin.start({ uploadAudio: false });
  const note = await s.fake.plugin.stop();
  await s.fake.plugin.putTranscript!({ id: note.id, transcript: {
    version: 2, noteId: note.id, transcriber: "on-device", rev: 1, engine: "apple-speech",
    model: null, language: "en", outcome: "transcribed", diarized: false,
    segments: [{ start: 0, end: 1000, text: "synthetic receipt case", speaker: null }],
    createdAt: "2026-10-15T00:00:00Z",
  } });
  const listPending = s.fake.plugin.listPending.bind(s.fake.plugin);
  const updateLedger = s.fake.plugin.updateLedger.bind(s.fake.plugin);
  let conflict = true;
  __setVoiceNotesForTests({ ...s.fake.plugin,
    updateLedger: async (args) => {
      if (conflict) { conflict = false; throw Object.assign(new Error("changed"), { code: "rev_conflict" }); }
      return updateLedger(args);
    },
    listPending: async () => ({
      recordings: (await listPending()).recordings.map((entry) => !conflict && entry.id === note.id
        ? { ...entry, stt: { ...entry.stt!, state: "done" as const } } : entry),
    }),
  }, { available: true });
  await s.pipeline.reconcileAll(s.ctx());
  expect((await readTranscriptCommit(s.tcw, note.id))?.rev).toBe(1);
});

test("v1MissingTranscriptSyncAcknowledgesOrStaysUnrecorded", async () => {
  const s = await setup("on-device");
  const note = await s.recordFor(s.tcw.did);
  await s.pipeline.reconcileAll(s.ctx());
  await s.fake.plugin.putTranscript!({ id: note.id, transcript: {
    version: 1, noteId: note.id, transcriber: "on-device", rev: 1, engine: "apple-speech",
    model: null, language: "en", outcome: "transcribed", diarized: false,
    segments: [{ start: 0, end: 1000, text: "synthetic imported note", speaker: null }],
    createdAt: "2026-10-15T00:00:00Z",
  } });
  const listPending = s.fake.plugin.listPending.bind(s.fake.plugin);
  const updateLedger = s.fake.plugin.updateLedger.bind(s.fake.plugin);
  let acknowledged = false;
  __setVoiceNotesForTests({ ...s.fake.plugin,
    listPending: async () => ({ recordings: (await listPending()).recordings.map((entry) => entry.id !== note.id || acknowledged
      ? entry : { ...entry, stt: { ...entry.stt!, state: "done" as const }, ledger: {
        ...entry.ledger!, transcript: undefined, transcriptSync: undefined,
      } as unknown as VoiceNoteRecording["ledger"] }) }),
    updateLedger: async (args) => {
      const result = await updateLedger(args);
      if (args.patch.transcriptSync?.state === "saved") acknowledged = true;
      return result;
    },
  }, { available: true });
  await s.pipeline.reconcileAll(s.ctx());
  expect((await readTranscriptCommit(s.tcw, note.id))?.rev).toBe(1);
  expect(acknowledged).toBe(true);
});

test("receiptRepairRequiresMatchingRevisionOutcomeHashAndBody", async () => {
  const s = await setup("on-device");
  const note = await s.recordFor(s.tcw.did);
  await s.pipeline.reconcileAll(s.ctx());
  await s.fake.plugin.putTranscript!({ id: note.id, transcript: {
    version: 2, noteId: note.id, transcriber: "on-device", rev: 1, engine: "apple-speech",
    model: null, language: "en", outcome: "transcribed", diarized: false,
    segments: [{ start: 0, end: 1000, text: "synthetic repairable body", speaker: null }],
    createdAt: "2026-10-15T00:00:00Z",
  } });
  const saved = (await s.fake.plugin.listPending()).recordings.find((entry) => entry.id === note.id)!;
  await s.fake.plugin.updateLedger({ id: note.id, did: s.tcw.did, rev: saved.rev!, patch: {
    transcriptSync: { state: "saved", rev: 1, at: Date.now() },
    transcript: { ...saved.ledger!.transcript, state: "done", outcome: "transcribed" },
  } });
  await recordOnDeviceTranscript(s.tcw, note.id, s.ctx());
  expect((await readTranscriptCommit(s.tcw, note.id))?.rev).toBe(1);
  const winner = await readTranscriptCommit(s.tcw, note.id);
  const body = await s.tcw.kv.get(winner!.bodyKey);
  expect(body.ok && JSON.stringify(body.data.data)).toContain("synthetic repairable body");
});

test("receipt repair restores a partial row mirror before acknowledging native saved receipt", async () => {
  const s = await setup("on-device");
  const note = await s.recordFor(s.tcw.did);
  await s.pipeline.reconcileAll(s.ctx());
  await s.fake.plugin.putTranscript!({ id: note.id, transcript: {
    version: 2, noteId: note.id, transcriber: "on-device", rev: 1, engine: "apple-speech",
    model: null, language: "en", outcome: "transcribed", diarized: false,
    segments: [{ start: 0, end: 1000, text: "synthetic mirror recovery", speaker: null }],
    createdAt: "2026-10-15T00:00:00Z",
  } });
  const saved = (await s.fake.plugin.listPending()).recordings.find((entry) => entry.id === note.id)!;
  await syncOnDeviceTranscript(s.tcw, saved, s.ctx());
  await s.tcw.sql.db(CONNECTORS_SQL_DB_NAME).execute(
    `UPDATE connector_meeting SET metadata = json_patch(metadata, ?) WHERE source_id = ?`,
    [JSON.stringify({ transcription_outcome: "pending", transcript_text: null, transcript_location: "device",
      device_transcript: { state: "done", rev: 1, transcribed_at: "2026-10-15T00:00:00Z" } }), note.id]);
  await recordOnDeviceTranscript(s.tcw, note.id, s.ctx());
  const mirror = (await resolveVoiceNoteRow(s.tcw, note.id))?.metadata;
  expect(mirror).toMatchObject({ transcription_outcome: "transcribed", transcript_text: "synthetic mirror recovery" });
  expect(mirror?.transcript_location).toBeUndefined();
});

test("savedReceiptRevNStillSyncsLocalRerunNPlusOne", async () => {
  const s = await setup("on-device");
  const note = await s.recordFor(s.tcw.did);
  await s.pipeline.reconcileAll(s.ctx());
  const base: LocalTranscript = {
    version: 2, noteId: note.id, transcriber: "on-device", rev: 1, engine: "apple-speech",
    model: null, language: "en", outcome: "transcribed", diarized: false,
    segments: [{ start: 0, end: 1000, text: "synthetic revision one", speaker: null }],
    createdAt: "2026-10-15T00:00:00Z",
  };
  await s.fake.plugin.putTranscript!({ id: note.id, transcript: base });
  const listPending = s.fake.plugin.listPending.bind(s.fake.plugin);
  __setVoiceNotesForTests({ ...s.fake.plugin, listPending: async () => ({
    recordings: (await listPending()).recordings.map((entry) => entry.id === note.id
      ? { ...entry, stt: { ...entry.stt!, state: "done" as const } } : entry),
  }) }, { available: true });
  await s.pipeline.reconcileAll(s.ctx());
  const first = await readTranscriptCommit(s.tcw, note.id);
  expect(first?.rev).toBe(1);
  await s.fake.plugin.putTranscript!({ id: note.id, transcript: {
    ...base, rev: 2, rerunBase: { rev: 1, hash: first!.hash },
    segments: [{ start: 0, end: 1000, text: "synthetic revision two", speaker: null }],
  } });
  await s.pipeline.reconcileAll(s.ctx());
  const second = await readTranscriptCommit(s.tcw, note.id);
  expect(second?.rev).toBe(2);
  expect((await s.tcw.kv.get(second!.bodyKey)).data.data).toContain("synthetic revision two");
});

test("completedLocalArtifactBeforeCommitKeepsPendingMarkerAndVerifiedCommitClearsIt", async () => {
  const s = await setup("on-device");
  const note = await s.recordFor(s.tcw.did);
  await s.pipeline.reconcileAll(s.ctx());
  await s.fake.plugin.putTranscript!({ id: note.id, transcript: {
    version: 2, noteId: note.id, transcriber: "on-device", rev: 1, engine: "apple-speech",
    model: null, language: "en", outcome: "transcribed", diarized: false,
    segments: [{ start: 0, end: 1000, text: "synthetic pending artifact", speaker: null }],
    createdAt: "2026-10-15T00:00:00Z",
  } });
  const originalPut = s.tcw.kv.put.bind(s.tcw.kv);
  let offline = true;
  s.tcw.kv.put = (async (...args: Parameters<typeof originalPut>) => offline && args[0].includes("/transcript-rev/")
    ? { ok: false, error: { code: "NETWORK_ERROR", message: "offline" } } as never
    : originalPut(...args)) as typeof s.tcw.kv.put;
  const saved = (await s.fake.plugin.listPending()).recordings.find((entry) => entry.id === note.id)!;
  await syncOnDeviceTranscript(s.tcw, saved, s.ctx());
  const pending = (await resolveVoiceNoteRow(s.tcw, note.id))?.metadata;
  expect(pending).toMatchObject({ transcription_outcome: "pending", transcript_location: "device",
    device_transcript: { state: "done", rev: 1 }, device_sync_error: expect.any(String) });
  expect((await readTranscriptCommit(s.tcw, note.id))).toBeNull();
  offline = false;
  await syncOnDeviceTranscript(s.tcw, saved, s.ctx());
  expect((await readTranscriptCommit(s.tcw, note.id))?.rev).toBe(1);
  const committed = (await resolveVoiceNoteRow(s.tcw, note.id))?.metadata;
  expect(committed).toMatchObject({ transcription_outcome: "transcribed" });
  expect(committed?.transcript_location).toBeUndefined();
  expect(committed?.device_transcript).toBeUndefined();
  expect(committed?.device_sync_error).toBeUndefined();
});

test("foreground transcript turns continue past sixteen saved notes without another launch", async () => {
  const s = await setup("on-device");
  const ids: string[] = [];
  for (let i = 0; i < 17; i++) {
    const note = await s.recordFor(s.tcw.did);
    ids.push(note.id);
    await s.pipeline.process(s.ctx(), note.id);
    await s.fake.plugin.putTranscript!({ id: note.id, transcript: {
      version: 2, noteId: note.id, transcriber: "on-device", rev: 1, engine: "apple-speech",
      model: null, language: "en", outcome: "transcribed", diarized: false,
      segments: [{ start: 0, end: 1000, text: `synthetic ${i}`, speaker: null }],
      createdAt: "2026-10-15T00:00:00Z",
    } });
  }
  const listPending = s.fake.plugin.listPending.bind(s.fake.plugin);
  __setVoiceNotesForTests({ ...s.fake.plugin, listPending: async () => ({
    recordings: (await listPending()).recordings.map((entry) => ids.includes(entry.id)
      ? { ...entry, stt: { ...entry.stt!, state: "done" as const } } : entry),
  }) }, { available: true });
  await s.pipeline.reconcileAll(s.ctx());
  await tick();
  await s.pipeline.quiescent(1000);
  const committed = await Promise.all(ids.map((id) => readTranscriptCommit(s.tcw, id)));
  expect(committed.filter((winner) => winner?.rev === 1)).toHaveLength(17);
  s.pipeline.cancelAll();
});

test("reconcile publishes an owner-only inventory snapshot before its audio queue", async () => {
  const s = await setup("on-device");
  const mine = await s.recordFor(s.tcw.did);
  await s.recordFor("did:test:another-owner");
  await s.pipeline.reconcileAll(s.ctx());
  await s.pipeline.quiescent(1000);
  const report = await readVoiceNotePendingSnapshot(s.tcw, s.ctx());
  expect(report).toMatchObject({ status: "fresh",
    snapshot: { pending_row: 1, oldest_started_at: new Date(mine.startedAt).toISOString() } });
  s.pipeline.cancelAll();
});

test("a transient transcript write retries without replaying saved audio", async () => {
  const s = await setup("on-device", [10]);
  const note = await s.recordFor(s.tcw.did);
  await s.pipeline.process(s.ctx(), note.id);
  const audioKeysBefore = [...s.values.keys()].filter((key) => key.includes(`/audio/${note.id}`));
  await s.fake.plugin.putTranscript!({ id: note.id, transcript: {
    version: 2, noteId: note.id, transcriber: "on-device", rev: 1, engine: "apple-speech",
    model: null, language: "en", outcome: "transcribed", diarized: false,
    segments: [{ start: 0, end: 1000, text: "synthetic retry", speaker: null }],
    createdAt: "2026-10-15T00:00:00Z",
  } });
  const listPending = s.fake.plugin.listPending.bind(s.fake.plugin);
  __setVoiceNotesForTests({ ...s.fake.plugin, listPending: async () => ({
    recordings: (await listPending()).recordings.map((entry) => entry.id === note.id
      ? { ...entry, stt: { ...entry.stt!, state: "done" as const } } : entry),
  }) }, { available: true });
  const originalPut = s.tcw.kv.put.bind(s.tcw.kv);
  let failed = false;
  s.tcw.kv.put = ((...args: Parameters<typeof originalPut>) => {
    if (!failed && args[0].includes(`/transcript-rev/${note.id}/`)) {
      failed = true;
      return Promise.resolve({ ok: false, error: { code: "NETWORK_ERROR", message: "offline" } } as never);
    }
    return originalPut(...args);
  }) as typeof s.tcw.kv.put;
  const synced = Promise.withResolvers<void>();
  const unsubscribe = subscribeOnDeviceTranscriptSync(() => {
    if (onDeviceTranscriptSyncState(s.tcw, note.id)?.state === "synced") synced.resolve();
  });
  try {
    await s.pipeline.reconcileAll(s.ctx());
    // Exercises the foreground timer itself; no clock guess is used to decide success.
    if (onDeviceTranscriptSyncState(s.tcw, note.id)?.state !== "synced") await synced.promise;
    expect(failed).toBe(true);
    expect((await readTranscriptCommit(s.tcw, note.id))?.rev).toBe(1);
    expect([...s.values.keys()].filter((key) => key.includes(`/audio/${note.id}`))).toEqual(audioKeysBefore);
  } finally { unsubscribe(); s.pipeline.cancelAll(); }
});

const PRIVATE_NOTE = { durationMs: 1000, source: "in_app" as const, options: { transcriber: "private-cloud" as const, identifySpeakers: false } };

test("a generation superseded while the hand-off's check is in flight resumes none of A's pending jobs with B's bearer", async () => {
  let account = "A";
  let answer: (response: Response) => void = () => {};
  const requests: string[] = [];
  const cleared: string[] = [];
  let pendingJob: { attemptId: string; transcriptionId: string } | null = { attemptId: "attempt-A", transcriptionId: "trn_A" };
  const api = createPrivateCloudApi("https://backend.example", {
    sessionStore: { getToken: () => account, isExpired: () => false } as unknown as SessionStore,
    fetchImpl: (async (url: string, init: RequestInit) => {
      requests.push(`${init.method}:${new Headers(init.headers).get("Authorization")}`);
      if (url.endsWith("/capabilities")) return new Promise<Response>((resolve) => { answer = resolve; });
      return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const cloud = createVoiceNoteCloud({ api, origin: "https://ptx.example",
    pending: { read: () => pendingJob, write() {}, clear: (id) => { cleared.push(id); pendingJob = null; }, sourceIds: () => pendingJob ? ["old-A-job"] : [] },
    create: async () => { throw new Error("unexpected create"); }, put: async () => { throw new Error("unexpected upload"); },
  });
  const transcriber = createVoiceNoteTranscriber({ cloud, holds: memoryHoldStore(), tcw: () => ({ did: "A" }) as TinyCloudWeb,
    consent: { get: () => true, set() {} },
    runNote: async (args) => {
      await cloud.transcribe({ sourceId: args.sourceId, capabilities: args.capabilities, allowed: args.allowed,
        loadAudio: async () => { throw new Error("unexpected audio read"); } }, args.report);
      return "no_speech";
    },
  });
  const generation = currentAccountGeneration();
  transcribeSavedNote(transcriber, { id: "new-A-note", ...PRIVATE_NOTE }, () => generation === currentAccountGeneration());
  account = "B";
  advanceAccountGeneration();
  answer(new Response(JSON.stringify(CAPS), { status: 200, headers: { "Content-Type": "application/json" } }));
  await tick();
  expect({ afterSwitch: requests.filter((request) => request.endsWith("Bearer B")), cleared }).toEqual({ afterSwitch: [], cleared: [] });
});

test("a hand-off for a generation that is already superseded does not even start a check", async () => {
  const checks: unknown[] = [];
  const transcriber = { check: (options: unknown) => { checks.push(options); return Promise.resolve(); }, noteSaved: () => { throw new Error("must not hand over"); } };
  transcribeSavedNote(transcriber, { id: "stale", ...PRIVATE_NOTE }, () => false);
  await tick();
  expect(checks).toEqual([]);
});

test("a hand-off's cached check leaves an earlier failed job waiting for Retry after an identity-paused job", async () => {
  let current = true;
  let interrupt: (error: unknown) => void = () => {};
  const runs: string[] = [];
  const cloud = { capabilities: async () => CAPS, pendingSourceIds: () => ["failed-note", "interrupted-note"],
    hasRemoteJob: () => true } as unknown as VoiceNoteCloud;
  const transcriber = createVoiceNoteTranscriber({ cloud, holds: memoryHoldStore(), tcw: () => ({}) as TinyCloudWeb,
    consent: { get: () => true, set() {} },
    runNote: async (args) => {
      runs.push(args.sourceId);
      if (args.sourceId === "failed-note") throw new PrivateCloudError("service_busy", "busy");
      if (args.sourceId === "interrupted-note" && runs.filter((id) => id === "interrupted-note").length === 1)
        return new Promise((_, reject) => { interrupt = reject; });
      return "no_speech";
    },
  });
  await transcriber.check({ current: () => current });
  await tick();
  expect(transcriber.snapshot().jobs.get("failed-note")?.kind).toBe("failed");
  current = false;
  interrupt(new PrivateCloudError("account_changed", "account left"));
  await tick();
  current = true;
  transcribeSavedNote(transcriber, { id: "saved-on-return", ...PRIVATE_NOTE }, () => current);
  await tick();
  expect(runs.filter((id) => id === "failed-note")).toEqual(["failed-note"]);
  expect(runs).toContain("saved-on-return");
  transcriber.transcribe("failed-note");
  await tick();
  expect(runs.filter((id) => id === "failed-note")).toEqual(["failed-note", "failed-note"]);
});

describe("the recorder's hand-off and reconcile's while the first availability check is still pending", () => {
  const delayed = (s: Awaited<ReturnType<typeof setup>>) => {
    let answer: (caps: PrivateCloudCapabilities) => void = () => {};
    const runs: string[] = [];
    const cloud = { capabilities: () => new Promise<PrivateCloudCapabilities>((resolve) => { answer = resolve; }), pendingSourceIds: () => [] } as unknown as VoiceNoteCloud;
    const transcriber = createVoiceNoteTranscriber({ cloud, holds: memoryHoldStore(), tcw: () => s.tcw,
      consent: { get: () => true, set() {} }, runNote: async (args) => { runs.push(args.sourceId); return "no_speech"; } });
    return { transcriber, runs, answer: (caps = CAPS) => answer(caps) };
  };

  test("recorder first (the controller's landed): the note still gets exactly one job", async () => {
    const s = await setup("private-cloud");
    const note = await s.recordFor(s.tcw.did);
    const d = delayed(s);
    const checking = d.transcriber.check();
    await s.pipeline.process(s.ctx(), note.id);
    const generation = currentAccountGeneration();
    transcribeSavedNote(d.transcriber, note, () => generation === currentAccountGeneration());
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", (saved) => transcribeSavedNote(d.transcriber, saved, () => true));
    d.answer();
    await checking;
    await tick();
    expect(d.runs).toEqual([note.id]);
  });

  test("reconcile first: the note still gets exactly one job when the recorder's hand-off follows", async () => {
    const s = await setup("private-cloud");
    const note = await s.recordFor(s.tcw.did);
    const d = delayed(s);
    const checking = d.transcriber.check();
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", (saved) => transcribeSavedNote(d.transcriber, saved, () => true));
    await s.pipeline.process(s.ctx(), note.id);
    transcribeSavedNote(d.transcriber, note, () => true);
    d.answer();
    await checking;
    await tick();
    expect(d.runs).toEqual([note.id]);
  });
});

test("a timed-out Stop retry creates the row, refreshes the Library, and starts Private", async () => {
  const s = await setup("private-cloud");
  const note = await s.recordFor(s.tcw.did);
  const db = s.tcw.sql.db(CONNECTORS_SQL_DB_NAME);
  let firstRow = true;
  const sql = s.tcw.sql as typeof s.tcw.sql & { db: typeof s.tcw.sql.db };
  sql.db = () => ({ ...db, execute: async (statement: string, params: unknown[] = []) => {
    if (firstRow && statement.includes("INSERT INTO connector_meeting")) {
      firstRow = false;
      throw new VoiceNoteSaveTimeout("first row insert", 1);
    }
    return db.execute(statement, params as never[]);
  } }) as ReturnType<typeof s.tcw.sql.db>;
  const pipeline = createVoiceNotePipeline(s.tcw, { retryDelaysMs: [], saveRetryDelaysMs: [60] });
  let autoStopped: (event: unknown) => void = () => { throw new Error("autoStopped listener not installed"); };
  const addListener = s.fake.plugin.addListener.bind(s.fake.plugin);
  s.fake.plugin.addListener = ((event: string, callback: (event: unknown) => void) => {
    if (event === "autoStopped") autoStopped = callback;
    return (addListener as (event: string, callback: (event: unknown) => void) => unknown)(event, callback);
  }) as typeof s.fake.plugin.addListener;
  const events: string[] = [];
  const off = captureEvents.on("library-changed", (event) => { if (event?.sourceId) events.push(event.sourceId); });
  const recorder = createVoiceNoteRecorderController({ tcw: s.tcw, available: true, transcriber: s.transcriber,
    pipeline, onDeviceReady: () => true });
  const detach = recorder.attach();
  try {
    autoStopped({ reason: "max_duration", maxDurationMs: 60_000, at: Date.now(), recording: note });
    for (let turn = 0; turn < 100 && !pendingStore.retryAt(note.id); turn++) await tick();
    expect(firstRow).toBe(false);
    expect(pendingStore.retryAt(note.id)).toBeGreaterThan(Date.now());
    expect(events).toEqual([]);
    expect(s.runs).toEqual([]);
    for (let turn = 0; turn < 200 && (!events.includes(note.id) || !s.runs.includes(note.id)); turn++) await tick();
    expect(events).toEqual([note.id]);
    expect(s.runs).toEqual([note.id]);
    expect((await s.fake.plugin.listPending()).recordings.find((entry) => entry.id === note.id)?.ledger?.audio.state).toBe("saved");
  } finally { off(); detach(); pipeline.cancelAll(); }
});

test("a recorder stop queued behind reconcile waits for the owning save before hand-off", async () => {
  const s = await setup("private-cloud");
  const first = await s.recordFor(s.tcw.did);
  const queued = await s.recordFor(s.tcw.did);
  const readAudioChunk = s.fake.plugin.readAudioChunk.bind(s.fake.plugin);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.fake.plugin.readAudioChunk = (async (options: Parameters<typeof readAudioChunk>[0]) => {
    if (options.id === first.id) { entered(); await gate; }
    return readAudioChunk(options);
  }) as typeof s.fake.plugin.readAudioChunk;

  let autoStopped: (event: unknown) => void = () => { throw new Error("autoStopped listener not installed"); };
  const addListener = s.fake.plugin.addListener.bind(s.fake.plugin);
  s.fake.plugin.addListener = ((event: string, callback: (event: unknown) => void) => {
    if (event === "autoStopped") autoStopped = callback;
    return (addListener as (event: string, callback: (event: unknown) => void) => unknown)(event, callback);
  }) as typeof s.fake.plugin.addListener;
  const recorder = createVoiceNoteRecorderController({ tcw: s.tcw, available: true, transcriber: s.transcriber,
    pipeline: s.pipeline, onDeviceReady: () => true });
  const detach = recorder.attach();
  const handed: string[] = [];
  const reconcile = s.pipeline.reconcileAll(s.ctx(), "reconcile", (note) => {
    handed.push(note.id);
    s.handOver()(note);
  });
  try {
    await started;
    autoStopped({ reason: "max_duration", maxDurationMs: 60_000, at: Date.now(), recording: queued });
    for (let i = 0; i < 5; i++) await tick();
    expect((await s.fake.plugin.listPending()).recordings.find((note) => note.id === queued.id)?.ledger?.audio.state).toBe("pending");
    expect(recorder.getState().localUpload).toBe("in-flight");
    expect(s.runs).toEqual([]);

    release();
    await reconcile;
    await tick();
    expect((await s.fake.plugin.listPending()).recordings.find((note) => note.id === queued.id)?.ledger?.audio.state).toBe("saved");
    expect(handed).toEqual([first.id, queued.id]);
  } finally {
    release();
    detach();
    await reconcile.catch(() => undefined);
  }
});

describe("a recorder save that finishes after the account changed never starts a new transcription", () => {
  afterEach(async () => {
    pendingStore.setAccount(null);
    await pendingStore.refresh(null);
  });

  // The final native ledger acknowledgement is held while the account leaves; the old controller then lands A's note.
  const lateSave = async (variant: "stopped" | "background" | "no-pipeline") => {
    const s = await setup("private-cloud");
    // The no-pipeline save remembers saved ids for the whole process, and every fake numbers its notes from 1: use a high id.
    if (variant === "no-pipeline") for (let i = 0; i < 49; i++) { await s.recordFor(s.tcw.did); }
    const note = await s.recordFor(s.tcw.did);
    const original = s.fake.plugin.updateLedger.bind(s.fake.plugin);
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    s.fake.plugin.updateLedger = async (request) => {
      const result = await original(request);
      if (request.id === note.id && request.patch.audio?.state === "saved") { entered(); await gate; }
      return result;
    };
    let autoStopped: (event: unknown) => void = () => { throw new Error("autoStopped listener not installed"); };
    const add = s.fake.plugin.addListener.bind(s.fake.plugin);
    s.fake.plugin.addListener = ((event: string, callback: (event: unknown) => void) => {
      if (event === "autoStopped") autoStopped = callback;
      return (add as (event: string, callback: (event: unknown) => void) => unknown)(event, callback);
    }) as typeof s.fake.plugin.addListener;
    const switchAccount = async () => {
      await started;
      advanceAccountGeneration();
      s.pipeline.cancelAll();
      release();
      for (let i = 0; i < 8; i++) await tick();
      await whenVoiceNoteSavesIdle();
    };
    const attach = (transcriber: VoiceNoteTranscriber) => {
      const recorder = createVoiceNoteRecorderController({ tcw: s.tcw, available: true, transcriber,
        pipeline: variant === "no-pipeline" ? undefined : s.pipeline, onDeviceReady: () => true });
      return { recorder, detach: recorder.attach() };
    };
    const fire = async (recorder: ReturnType<typeof attach>["recorder"]) => {
      if (variant === "background") await recorder.record();
      autoStopped({ reason: "max_duration", maxDurationMs: 60000, at: Date.now(), recording: note });
    };
    return { s, note, attach, fire, switchAccount };
  };

  for (const variant of ["stopped", "background", "no-pipeline"] as const) {
    test(`${variant}: any early Private job stays with A after the generation moves on`, async () => {
      const { s, attach, fire, switchAccount } = await lateSave(variant);
      let account = "A";
      const runs: string[] = [];
      const cloud = { capabilities: async () => CAPS, pendingSourceIds: () => [] } as unknown as VoiceNoteCloud;
      const transcriber = createVoiceNoteTranscriber({ cloud, holds: memoryHoldStore(), tcw: () => s.tcw,
        consent: { get: () => true, set() {} },
        runNote: async (args) => { runs.push(`${args.sourceId}:${account}:${args.allowed!("account")}`); return "no_speech"; } });
      await transcriber.check({ current: () => account === "A" });
      const { recorder, detach } = attach(transcriber);
      await tick();
      await fire(recorder);
      await switchAccount();
      account = "B";
      detach();
      expect(runs.every((run) => run.includes(":A:"))).toBe(true);
    });
  }

  test("A's persisted job sends no request with B's bearer after the account transition", async () => {
    const { s, note, attach, fire, switchAccount } = await lateSave("stopped");
    let account = "A";
    const requests: string[] = [];
    const cleared: string[] = [];
    let pendingJob: { attemptId: string; transcriptionId: string } | null = null;
    const api = createPrivateCloudApi("https://backend.example", {
      sessionStore: { getToken: () => account, isExpired: () => false } as unknown as SessionStore,
      fetchImpl: (async (url: string, init: RequestInit) => {
        requests.push(`${init.method}:${new Headers(init.headers).get("Authorization")}`);
        return new Response(JSON.stringify(url.endsWith("/capabilities") ? CAPS : {}),
          { status: url.endsWith("/capabilities") ? 200 : 404, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    const cloud = createVoiceNoteCloud({ api, origin: "https://ptx.example",
      pending: { read: () => pendingJob, write() {}, clear: (id) => { cleared.push(id); pendingJob = null; }, sourceIds: () => pendingJob ? [note.id] : [] },
      create: async () => { throw new Error("unexpected create"); }, put: async () => { throw new Error("unexpected upload"); },
      decode: async () => { throw new Error("injected decoder stops after the wrong-account GET"); },
    });
    const transcriber = createVoiceNoteTranscriber({ cloud, holds: memoryHoldStore(), tcw: () => s.tcw, consent: { get: () => true, set() {} } });
    await transcriber.check({ current: () => account === "A" });
    const { recorder, detach } = attach(transcriber);
    await tick();
    await fire(recorder);
    pendingJob = { attemptId: "attempt-A", transcriptionId: "trn_A" };
    await switchAccount();
    account = "B";
    detach();
    expect(requests.filter((request) => request.endsWith("Bearer B"))).toEqual([]);
  });
});
