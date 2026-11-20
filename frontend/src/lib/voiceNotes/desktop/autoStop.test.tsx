// A Mac recording that the app stops at its limit ("Stop recording after", one hour by default). The owner was in a
// call, the window was behind it, nobody answered "Keep recording?", so the recorder stopped by itself. The rule: that
// recording keeps its audio, exactly as after Stop. Its note gets its audio on this Mac, the Whisper job transcribes
// it, and nothing about the next recording (started from the call tile a minute later, while the first one's end state
// is still on screen) loses or strands it. The real desktop engine, Whisper queue, recorder controller and save
// pipeline run here; the native commands, the Whisper server and the space are fakes. The fake native recorder does
// what the Rust engine does: at the limit it stops the source, emits its idle state and then `recorder-auto-stopped`;
// the source is a file of its own until something imports it into the note's audio file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { recorderActive } from "@/capture/recorder/RecorderProvider";
import { recordShortcutAction } from "@/capture/recorder/recordShortcut";
import { createVoiceNoteRecorderController } from "@/capture/recorder/voiceNoteRecorderController";
import type { TranscriptionEvent } from "@/lib/anarlog/transcription.gen";
import { CONNECTORS_SQL_DB_NAME } from "@/lib/connectors/connectorStore";
import { installDom } from "@/test/dom";
import { currentAccountGeneration } from "../accountContext";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests } from "../captureEngine";
import { installVoiceNotesEngine, VoiceNotes, type VoiceNoteRecording } from "../nativeVoiceNotes";
import { pendingStore } from "../recorderSaves";
import { createVoiceNotePipeline } from "../voiceNotePipeline";
import { ensureVoiceNoteIdentity } from "../voiceNoteRows";
import { newIdbEnv } from "../web/testing/idb";
import { memoryLocks } from "../web/webStore";
import type { IdbEnv } from "../web/idb";
import { openDesktopVoiceNotes, type DesktopBridge } from "./desktopVoiceNotes";
import { registerDesktopWhisperQueue, type DesktopWhisperBridge } from "./desktopWhisper";

const SPOKEN = "Book the venue for Friday";
const MODEL = "QuantizedTinyEn";
const SLOW = 30_000;
const TIMING = { retryDelaysMs: [], saveRetryDelaysMs: [25], drainProbeBackoffMs: 25, drainProbeTimeoutMs: 500 };
const HOUR = 60 * 60_000;

let spaces = 0;
/** The space, answering like the real one. */
function space() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = `did:test:auto-stop-${++spaces}`;
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
  const rows = (table: string, id: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE source_id = ?`).get(id) as { n: number }).n;
  const metadata = (id: string): Record<string, unknown> | null => {
    const found = sqlite.prepare("SELECT metadata FROM connector_meeting WHERE source_id = ?").get(id) as { metadata: string } | null;
    return found ? JSON.parse(found.metadata) as Record<string, unknown> : null;
  };
  return { tcw, did, rows, metadata };
}

type Journal = { id: string; startedAt: number; recordedMs: number; pausedMs: number; maxDurationMs: number; layout: "stereo" };

/**
 * The Tauri commands over in-memory files, with the Rust engine's bookkeeping: the note's audio file (`files`), the
 * recorded source of each segment until it is imported (`sources`), the active journal and the stopped journals.
 * `recorder_stop` is the engine's own stop: what the limit's auto-stop runs (engine.rs `install`).
 */
class FakeBridge implements DesktopBridge {
  files = new Map<string, Uint8Array>();
  sources = new Map<string, Uint8Array>();
  active: (Journal & { segment: boolean }) | null = null;
  stopped: (Journal & { segment: boolean })[] = [];
  current: string | null = null;
  state: "idle" | "recording" = "idle";
  reason: string | null = null;
  elapsed = 0;
  now = Date.now();
  limit = HOUR;
  listeners = new Map<string, Set<(payload: never) => void>>();
  calls: string[] = [];
  emit(event: string, payload: unknown) { for (const callback of this.listeners.get(event) ?? []) callback(payload as never); }
  status() {
    return { state: this.state, reason: this.reason, id: this.current, startedAt: this.current ? this.now : null,
      elapsedMs: this.elapsed, audioMs: this.elapsed, channels: 2, pausedMs: 0, maxDurationMs: this.limit,
      intent: this.state === "idle" ? "stopped" : "recording", availability: "available", at: this.now, elapsedAt: this.now,
      spans: [], captureSourceUnconfirmed: false, discardCleanupPending: false };
  }
  async listen<T>(event: string, callback: (payload: T) => void): Promise<() => void> {
    const set = this.listeners.get(event) ?? new Set();
    set.add(callback as (payload: never) => void);
    this.listeners.set(event, set);
    return () => set.delete(callback as (payload: never) => void);
  }
  /** Imports a stopped segment's source into the note's audio file, once (files.rs `import_segment`). */
  private importSource(id: string) {
    const source = this.sources.get(id);
    if (!source) return;
    this.files.set(id, source.slice());
    this.sources.delete(id);
  }
  /** The recording reaches its limit: the engine stops it by itself (engine.rs, the auto-stop in `install`). */
  async autoStop(): Promise<string> {
    const id = this.current!;
    const result = await this.invoke<{ elapsedMs: number; pausedMs: number; maxDurationMs: number; channels: 1 | 2 }>("recorder_stop");
    this.emit("exo://recorder-auto-stopped", { id, reason: "max_duration", maxDurationMs: result.maxDurationMs,
      at: this.now, elapsedMs: result.elapsedMs, pausedMs: result.pausedMs, channels: result.channels, spans: [] });
    return id;
  }
  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(command);
    const id = String(args.id ?? "");
    let result: unknown = null;
    switch (command) {
      case "recorder_models_get": result = MODEL; break;
      case "recorder_models_list": result = [{ id: MODEL, downloaded: true }]; break;
      case "recorder_recover": {
        // engine.rs `recorder_recover`: a journal still pointing at a segment is imported, then reported.
        if (this.active?.segment) { this.importSource(this.active.id); this.active.segment = false; }
        for (const entry of this.stopped) if (entry.segment) { this.importSource(entry.id); entry.segment = false; }
        result = { journal: this.active, stopped: this.stopped, quarantined: [] };
        break;
      }
      case "recorder_stopped_list": result = this.stopped.map((entry) => entry.id); break;
      case "recorder_failed_list": result = []; break;
      case "recorder_failed_retry": result = []; break;
      case "recorder_acknowledge": {
        // engine.rs `recorder_acknowledge`: refused while a journal still points at a segment that is not imported.
        const stopped = this.stopped.find((entry) => entry.id === id);
        if (stopped) {
          if (stopped.segment && this.sources.has(id)) throw new Error("journal_not_ready");
          this.stopped = this.stopped.filter((entry) => entry.id !== id);
          if (this.active?.id === id) this.active = null;
          break;
        }
        if (this.current) throw new Error("recording_in_progress");
        if (this.active && (this.active.id !== id || this.active.segment)) throw new Error("journal_not_ready");
        this.active = null;
        break;
      }
      case "recorder_status": result = this.status(); break;
      case "recorder_list_inputs": result = { inputs: [{ id: "mic-1", name: "Fixture microphone", kind: "built_in" }],
        selectedId: null, activeId: "mic-1", selectedMissing: null }; break;
      case "recorder_set_max_duration": case "recorder_select_input": break;
      case "recorder_start":
        // engine.rs `recorder_start`: refused while any active journal exists.
        if (this.active) throw new Error("recovery_pending");
        if (this.current) throw new Error("recording_in_progress");
        this.current = id; this.state = "recording"; this.reason = null; this.elapsed = 0;
        this.limit = Number(args.maxDurationMs ?? HOUR);
        this.active = { id, startedAt: this.now, recordedMs: 0, pausedMs: 0, maxDurationMs: this.limit, layout: "stereo", segment: true };
        result = this.status();
        this.emit("exo://recorder-mic-state", result); break;
      case "recorder_stop_durable": {
        // engine.rs `recorder_stop_durable`: the source is closed and durable; the stopped journal points at it.
        const cur = this.current!;
        this.sources.set(cur, Uint8Array.from({ length: 64 }, (_, index) => index));
        this.stopped.push({ ...this.active!, recordedMs: this.elapsed, segment: true });
        this.active = null;
        result = { ...this.status(), state: "idle", intent: "stopped", reason: null, id: cur };
        this.state = "idle"; this.current = null; this.elapsed = 0;
        this.emit("exo://recorder-mic-state", this.status());
        break;
      }
      case "recorder_stop": {
        // engine.rs `recorder_stop` -> `recorder_pause`: the segment is closed, imported into the note's file, and the
        // active journal stays (segmentId null) until JS acknowledges its commit.
        const cur = this.current!;
        this.sources.set(cur, Uint8Array.from({ length: 64 }, (_, index) => index));
        this.importSource(cur);
        this.active = { ...this.active!, recordedMs: this.elapsed, segment: false };
        this.reason = "max_duration";
        result = { ...this.status(), state: "idle", intent: "stopped", reason: "max_duration" };
        this.state = "idle"; this.current = null;
        this.emit("exo://recorder-mic-state", this.status());
        this.elapsed = 0;
        break;
      }
      case "recorder_finish": {
        // engine.rs `recorder_finish`: imports the stopped segment, then reports the note's audio size.
        const stopped = this.stopped.find((entry) => entry.id === id);
        if (!stopped) throw new Error("capture_journal_missing");
        if (stopped.segment) { this.importSource(id); stopped.segment = false; }
        result = this.files.get(id)?.length ?? 0; break;
      }
      case "audio_file_size": result = this.files.get(id)?.length ?? 0; break;
      case "finalize_audio_file":
        if (!this.files.has(id)) throw new Error("not_found");
        result = this.files.get(id)!.length; break;
      case "read_audio_chunk":
        result = (this.files.get(id) ?? new Uint8Array()).slice(Number(args.offset), Number(args.offset) + Number(args.len)); break;
      case "recorder_whisper_stage_audio":
        if (!this.files.has(id)) throw new Error("audio_not_ready");
        this.files.set(String(args.stageId), this.files.get(id)!.slice()); break;
      case "recorder_whisper_cleanup_stages":
        for (const key of [...this.files.keys()]) if (key.startsWith("whisper-")) this.files.delete(key);
        result = 0; break;
      case "delete_audio_file": this.files.delete(id); this.sources.delete(id); break;
      default: throw new Error(`Unexpected command ${command}`);
    }
    return result as T;
  }
}

/** The local Whisper server: it answers when told to. */
class FakeWhisper implements DesktopWhisperBridge {
  serverScope = {};
  starts: string[] = [];
  /** The note being transcribed now. */
  running: string | null = null;
  listeners = new Set<(event: TranscriptionEvent) => void>();
  async startServer() { return "http://127.0.0.1:0"; }
  async stopServer() {}
  async onTranscription(cb: (event: TranscriptionEvent) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  async startTranscription(params: { id: string }) { this.starts.push(params.id); this.running = params.id; }
  async stopTranscription(id: string) {
    if (this.running === id) this.running = null;
    this.emit({ type: "stopped", session_id: id } as TranscriptionEvent);
  }
  complete(id: string) {
    this.running = null;
    this.emit({ type: "completed", session_id: id, mode: "direct",
      response: { metadata: null, results: { channels: [{ alternatives: [{ transcript: SPOKEN, confidence: 1 }] }] } } } as TranscriptionEvent);
  }
  emit(event: TranscriptionEvent) { for (const cb of [...this.listeners]) cb(event); }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(5);
  }
  return false;
}

interface World { space: ReturnType<typeof space>; bridge: FakeBridge; whisper: FakeWhisper; env: IdbEnv; dbName: string;
  page: Awaited<ReturnType<typeof openPage>> }

/** One page of the Mac app over the stores that outlive it. As installDesktopEngine: recover, then resume Whisper. */
async function openPage(w: Omit<World, "page">) {
  const engine = await openDesktopVoiceNotes({ bridge: w.bridge, whisper: w.whisper, now: () => w.bridge.now,
    storeOptions: { env: w.env, dbName: w.dbName, locks: memoryLocks(), decodeCheck: null } });
  installVoiceNotesEngine(engine.plugin);
  __setInstalledEngineForTests("tauri", engine.plugin.capabilities);
  pendingStore.setAccount(w.space.did);
  const booted = (async () => { await engine.recoverInterrupted(); await engine.whisper?.resume(); })();
  const pipeline = createVoiceNotePipeline(w.space.tcw, TIMING);
  const recorder = createVoiceNoteRecorderController({ tcw: w.space.tcw, available: true, transcriber: null, pipeline, onDeviceReady: () => true });
  const detach = recorder.attach();
  const ctx = { did: w.space.did, spaceId: w.space.did, generation: currentAccountGeneration() };
  void booted.then(() => pipeline.reconcileAll(ctx, "reconcile")).catch(() => undefined);
  return { engine, pipeline, recorder, detach, booted,
    async close() {
      detach(); pipeline.cancelAll(); engine.dispose();
      registerDesktopWhisperQueue(null);
      pendingStore.setAccount(null);
    } };
}

async function world(): Promise<World> {
  const w = { space: space(), bridge: new FakeBridge(), whisper: new FakeWhisper(), env: newIdbEnv(), dbName: crypto.randomUUID() };
  const boot = await openDesktopVoiceNotes({ bridge: w.bridge, whisper: w.whisper, now: () => w.bridge.now,
    storeOptions: { env: w.env, dbName: w.dbName, locks: memoryLocks(), decodeCheck: null } });
  await boot.plugin.setCaptureDefaults({ accountDid: w.space.did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false, uploadAudio: false });
  boot.dispose();
  registerDesktopWhisperQueue(null);
  expect((await ensureVoiceNoteIdentity(w.space.tcw)).status).toBe("established");
  const full = { ...w, page: await openPage(w) } as World;
  expect(await waitFor(() => full.page.recorder.getState().ready)).toBe(true);
  return full;
}

const pendingOf = async (id: string): Promise<VoiceNoteRecording | undefined> =>
  (await VoiceNotes.listPending()).recordings.find((note) => note.id === id);

/** What a note's owner gets on this Mac: its audio, its transcript, its row in the space. */
async function expectKeptAndTranscribed(w: World, id: string): Promise<void> {
  expect(await waitFor(() => w.whisper.running === id)).toBe(true);
  w.whisper.complete(id);
  expect(await waitFor(async () => (await VoiceNotes.getTranscript({ id })).transcript?.segments.some((s) => s.text.includes(SPOKEN)) === true)).toBe(true);
  expect(w.bridge.files.get(id)?.length).toBe(64);
  expect((await VoiceNotes.localAudioSize({ id })).size).toBe(64);
  expect((await pendingOf(id))?.ledger?.localAudio?.state ?? "ready").toBe("ready");
  expect(await waitFor(() => w.space.rows("connector_meeting", id) === 1)).toBe(true);
  expect(w.space.metadata(id)?.audio).toMatchObject({ stored: false, reason: "local_only" });
  // Nothing of it is left for a launch to find: no source, no journal.
  expect(w.bridge.sources.has(id)).toBe(false);
  expect(w.bridge.stopped.some((entry) => entry.id === id)).toBe(false);
  expect(w.bridge.active?.id === id).toBe(false);
}

let cleanDom: (() => void) | undefined;
let current: World | null = null;
beforeEach(() => {
  cleanDom = installDom({});
  localStorage.removeItem("exo.voiceNotes.uploadAudio");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {
    metadata: { currentWindow: { label: "main" } }, transformCallback: () => 1, invoke: async () => 1 } });
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { configurable: true, value: { unregisterListener: () => undefined } });
});
afterEach(async () => {
  if (current) await current.page.close();
  current = null;
  __resetCaptureEngineForTests();
  cleanDom?.();
});

describe("a Mac recording the app stops at its limit", () => {
  test("keeps its audio: the note gets its audio on this Mac and is transcribed, exactly as after Stop", async () => {
    const w = current = await world();
    await w.page.recorder.record();
    expect(w.bridge.current).toBeTruthy();
    w.bridge.elapsed = HOUR;
    const id = await w.bridge.autoStop();
    await expectKeptAndTranscribed(w, id);
  }, SLOW);

  test("starting the next recording right after an automatic stop does not lose or strand the first", async () => {
    const w = current = await world();
    await w.page.recorder.record();
    w.bridge.elapsed = HOUR;
    const first = await w.bridge.autoStop();
    // The call goes on: the tile offers again and the owner presses its Start. The first recording's end is still on
    // screen; the app's Start (record_launch) opens the recorder over it, and its receipt goes by itself.
    const shortcut = () => recordShortcutAction({ available: true, ready: w.page.recorder.getState().ready,
      active: recorderActive(w.page.recorder.getState()) });
    expect(await waitFor(() => {
      if (shortcut() === "open" && w.page.recorder.getState().phase === "idle") w.page.recorder.dismissOutcome();
      return shortcut() === "record";
    })).toBe(true);
    await w.page.recorder.record();
    const second = w.bridge.current!;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    w.bridge.elapsed = 47 * 60_000;
    await w.page.recorder.stop();
    await expectKeptAndTranscribed(w, first);
    await expectKeptAndTranscribed(w, second);
  }, SLOW);
});
