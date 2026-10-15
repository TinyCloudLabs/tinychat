import { setTimeout as tick } from "node:timers/promises";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { PendingVoiceNotesSaver } from "@/chat/PendingVoiceNotesSaver";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { createFakeOnDeviceStt } from "./fakeOnDeviceStt";
import { OnDeviceStt, __setOnDeviceSttForTests } from "./onDeviceStt";
import { VoiceNotes, __setVoiceNotesForTests, type LocalTranscript } from "./nativeVoiceNotes";
import { advanceAccountGeneration, currentAccountGeneration } from "./accountContext";
import { createVoiceNotePipeline } from "./voiceNotePipeline";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { commitVoiceNoteTranscript, resolveVoiceNoteRow } from "./voiceNoteRows";
import { syncOnDeviceTranscriptAttempt, onDeviceTranscriptSyncState } from "./onDeviceTranscriber";
import { CONNECTORS_SQL_DB_NAME } from "../connectors/connectorStore";

const original = VoiceNotes;
const originalStt = OnDeviceStt;
afterEach(() => { __setVoiceNotesForTests(original, { available: null }); __setOnDeviceSttForTests(originalStt); });
let sequence = 0;
function fixture() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = `did:test:astra-s1-${++sequence}`;
  const tcw = { did, spaceId: did, sql: { db: () => ({
    query: async (statement: string, params: unknown[] = []) => {
      try { return { ok: true, data: { rows: sqlite.prepare(statement).all(...params as never[]).map((r) => Object.values(r as object)) } }; }
      catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error) } }; }
    },
    execute: async (statement: string, params: unknown[] = []) => {
      try { return { ok: true, data: { changes: sqlite.prepare(statement).run(...params as never[]).changes } }; }
      catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error) } }; }
    },
  }) }, kv: {
    put: async (key: string, value: string, options?: { ifNoneMatch?: string }) => {
      if (options?.ifNoneMatch === "*" && values.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "412" } };
      values.set(key, value); return { ok: true, data: {} };
    },
    get: async (key: string) => values.has(key) ? { ok: true, data: { data: values.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } },
    list: async ({ path }: { path: string }) => ({ ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)), truncated: false } }),
  } } as unknown as TinyCloudWeb;
  const fake = createFakeVoiceNotes();
  const done = new Set<string>();
  const list = fake.plugin.listPending.bind(fake.plugin);
  const plugin = { ...fake.plugin, listPending: async () => ({ recordings: (await list()).recordings.map((note) => done.has(note.id)
    ? { ...note, stt: { ...note.stt!, state: "done" as const } } : note) }) };
  __setVoiceNotesForTests(plugin, { available: true });
  const pipeline = createVoiceNotePipeline(tcw, { retryDelaysMs: [], transcriptRetryDelaysMs: [5, 10, 20], transcriptPassCooldownMs: 5 });
  const ctx = () => ({ did: tcw.did, spaceId: tcw.spaceId!, generation: currentAccountGeneration() });
  async function record(saved = true) {
    await fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false, uploadAudio: false });
    await fake.plugin.start({ uploadAudio: false });
    const note = await fake.plugin.stop();
    if (saved) await pipeline.process(ctx(), note.id);
    return note;
  }
  async function complete(id: string, rev = 1) {
    const transcript: LocalTranscript = { version: 2, noteId: id, transcriber: "on-device", rev, engine: "apple-speech", model: null, language: "en", outcome: "no_speech", diarized: false, segments: [], createdAt: "2026-10-15T00:00:00Z" };
    await fake.plugin.putTranscript!({ id, transcript });
    done.add(id);
  }
  return { tcw, sqlite, values, fake, plugin, pipeline, ctx, record, complete };
}

test("Astra: live completion with saved audio but no row remains deferred, not terminal", async () => {
  const s = fixture();
  const note = await s.record();
  await s.complete(note.id);
  await s.tcw.sql.db(CONNECTORS_SQL_DB_NAME).execute("DELETE FROM connector_meeting WHERE source_id = ?", [note.id]);
  const listed = (await s.plugin.listPending()).recordings.find((n) => n.id === note.id)!;
  listed.ledger!.audio.rowId = null;
  const list = s.plugin.listPending;
  s.plugin.listPending = async () => ({ recordings: (await list()).recordings.map((n) => n.id === note.id ? { ...n, ledger: { ...n.ledger!, audio: { ...n.ledger!.audio, rowId: null } } } : n) });
  try {
    const result = await syncOnDeviceTranscriptAttempt(s.tcw, listed, s.ctx());
    expect(result.state).toBe("deferred");
    expect(onDeviceTranscriptSyncState(s.tcw, note.id)).toBeNull();
  } finally { s.pipeline.cancelAll(); }
});

test("Astra: eight completed transcripts yield to an unrelated row before inspecting a stalled ninth", async () => {
  const s = fixture();
  const ids: string[] = [];
  for (let i = 0; i < 9; i++) { const n = await s.record(); ids.push(n.id); await s.complete(n.id); }
  const pending = await s.record(false);
  const sorted = (await s.plugin.listPending()).recordings.filter((n) => ids.includes(n.id)).sort((a,b) => a.startedAt-b.startedAt || a.id.localeCompare(b.id));
  const ninth = sorted[8]!.id;
  const read = s.plugin.getTranscript;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  s.plugin.getTranscript = async (args) => { if (args.id === ninth) { entered.resolve(); await gate.promise; } return read(args); };
  const reconcile = s.pipeline.reconcileAll(s.ctx());
  await entered.promise;
  let rowBeforeRelease;
  try {
    await tick();
    rowBeforeRelease = await resolveVoiceNoteRow(s.tcw, pending.id);
  } finally { gate.resolve(); await reconcile; s.pipeline.cancelAll(); }
  expect(rowBeforeRelease?.sourceId).toBe(pending.id);
});

test("Astra: mounted native completion transient failure retries without another lifecycle event", async () => {
  const s = fixture();
  const note = await s.record();
  const stt = createFakeOnDeviceStt();
  __setOnDeviceSttForTests(stt.plugin);
  await stt.plugin.enqueue({ id: note.id });
  const global = globalThis as Record<string, unknown>;
  const oldWindow = global.window;
  const oldAct = global.IS_REACT_ACT_ENVIRONMENT;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {} };
  const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<PendingVoiceNotesSaver tcw={s.tcw} pipeline={s.pipeline} backendUrl="" sessionStore={{ getToken: () => null, isExpired: () => true } as never} />));
    await s.pipeline.quiescent(1000);
    await act(async () => { await tick(); });
    await s.complete(note.id);
    const put = s.tcw.kv.put.bind(s.tcw.kv);
    let failures = 0;
    s.tcw.kv.put = ((...args: Parameters<typeof put>) => {
      if (args[0].includes(`/transcript-rev/${note.id}/`) && failures++ === 0)
        return Promise.resolve({ ok: false, error: { code: "NETWORK_ERROR", message: "synthetic transient unavailable" } } as never);
      return put(...args);
    }) as typeof put;
    await act(async () => { stt.controls.finish(note.id, "no_speech"); await tick(); });
    await act(async () => { await tick(200); });
    expect(failures).toBeGreaterThan(0);
    expect((await readTranscriptCommit(s.tcw, note.id))?.rev).toBe(1);
    expect(onDeviceTranscriptSyncState(s.tcw, note.id)?.state).toBe("synced");
  } finally {
    await act(async () => root.unmount());
    s.pipeline.cancelAll(); global.window = oldWindow; global.IS_REACT_ACT_ENVIRONMENT = oldAct;
  }
});

test("Astra positive: a newer authoritative winner prevents local acknowledgement or downgrade", async () => {
  const s = fixture();
  const note = await s.record();
  await s.complete(note.id);
  await commitVoiceNoteTranscript(s.tcw, note.id, { rev: 2, sentences: [], outcome: "no_speech", text: null });
  const listed = (await s.plugin.listPending()).recordings.find((n) => n.id === note.id)!;
  try {
    expect((await syncOnDeviceTranscriptAttempt(s.tcw, listed, s.ctx())).state).toBe("terminal");
    expect((await readTranscriptCommit(s.tcw, note.id))?.rev).toBe(2);
    expect((await resolveVoiceNoteRow(s.tcw, note.id))?.metadata.transcription_outcome).toBe("no_speech");
    const after = (await s.plugin.listPending()).recordings.find((n) => n.id === note.id)!;
    expect(after.ledger?.transcriptSync.state).not.toBe("saved");
  } finally { s.pipeline.cancelAll(); }
});

test("Astra positive: account generation change during native read fences commit and receipt", async () => {
  const s = fixture();
  const note = await s.record();
  await s.complete(note.id);
  const listed = (await s.plugin.listPending()).recordings.find((n) => n.id === note.id)!;
  const read = s.plugin.getTranscript;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  s.plugin.getTranscript = async (args) => { entered.resolve(); await gate.promise; return read(args); };
  const sync = syncOnDeviceTranscriptAttempt(s.tcw, listed, s.ctx());
  await entered.promise;
  advanceAccountGeneration();
  gate.resolve();
  try {
    expect((await sync).state).toBe("abandoned");
    expect(await readTranscriptCommit(s.tcw, note.id)).toBeNull();
    const after = (await s.plugin.listPending()).recordings.find((n) => n.id === note.id)!;
    expect(after.ledger?.transcriptSync.state).not.toBe("saved");
  } finally { s.pipeline.cancelAll(); }
});
