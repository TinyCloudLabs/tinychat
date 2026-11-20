// Stop on a long Mac recording: what the page holds of its audio afterwards. On the owner's Mac the page grew from
// 429 MB to 1.3 GB at the Stop of a 1 h 37 min call (an MP3 of 44.3 MiB; audio upload off; the space unreachable). At
// Stop the saved receipt read the whole file through the bridge into one array, and copied it into a Blob, to show its
// Play control.
// Here a two-hour recording is stopped with the real engine, Whisper queue, recorder controller, save pipeline and
// receipt; the native commands, the Whisper server and the space are fakes. Every read of the audio is counted: none
// may ask for more than one native call carries, whatever the recording's length.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { ReceiptView } from "@/capture/recorder/ReceiptView";
import { StaticRecorderProvider, useRecorder } from "@/capture/recorder/RecorderProvider";
import { createVoiceNoteRecorderController } from "@/capture/recorder/voiceNoteRecorderController";
import type { TranscriptionEvent } from "@/lib/anarlog/transcription.gen";
import { CONNECTORS_SQL_DB_NAME } from "@/lib/connectors/connectorStore";
import { PlatformContext } from "@/lib/platform";
import { installDom } from "@/test/dom";
import { currentAccountGeneration } from "../accountContext";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests } from "../captureEngine";
import { installVoiceNotesEngine, VoiceNotes, type VoiceNoteRecording } from "../nativeVoiceNotes";
import { pendingStore } from "../recorderSaves";
import { createVoiceNotePipeline } from "../voiceNotePipeline";
import { ensureVoiceNoteIdentity } from "../voiceNoteRows";
import { newIdbEnv } from "../web/testing/idb";
import { memoryLocks, openWebStore, type AudioBlobStore, type WebStore } from "../web/webStore";
import { openDesktopVoiceNotes, type DesktopBridge } from "./desktopVoiceNotes";
import { registerDesktopWhisperQueue, type DesktopWhisperBridge } from "./desktopWhisper";
import { createFileAudioBlobStore } from "./fileAudioBlobStore";

const MiB = 1024 * 1024;
/** Two hours at the rate of the owner's recording (44.3 MiB for 1 h 37 min). */
const TWO_HOURS_MS = 2 * 60 * 60_000;
const TWO_HOURS_BYTES = Math.round((44.3 * MiB * 120) / 97) + 123;
/** What one native read carries (read_audio_chunk): no read of the page's may ask for more. */
const ONE_NATIVE_READ = 4 * MiB;
/** The most the file store serves in one read (two native reads). */
const LARGEST_STORE_READ = 2 * ONE_NATIVE_READ;
const MODEL = "QuantizedTinyEn";
const SLOW = 60_000;
const TIMING = { retryDelaysMs: [], saveRetryDelaysMs: [25], drainProbeBackoffMs: 25, drainProbeTimeoutMs: 500 };
const NODE_DOWN = { code: "NODE_NOT_RESPONDING", message: "The place your data is stored isn't responding right now. Please try again." };

/** The recording's byte at `offset`: a pattern with a period that no read boundary lines up with. */
const byteAt = (offset: number) => offset % 251;

/** `length` bytes of the recording from `offset`, made without per-byte work for most of them. */
function bytesAt(offset: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const period = Math.min(length, 251);
  for (let i = 0; i < period; i++) bytes[i] = byteAt(offset + i);
  for (let filled = period; filled < length;) {
    const copy = Math.min(filled, length - filled);
    bytes.set(bytes.subarray(0, copy), filled);
    filled += copy;
  }
  return bytes;
}

let spaces = 0;
/** The space: answers like the real one, or fails every call as the SDK does while the node is down. */
function space() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, unknown>();
  const did = `did:test:stop-memory-${++spaces}`;
  const state = { down: false };
  const refuse = () => ({ ok: false as const, error: { ...NODE_DOWN } });
  const sql = {
    db(name: string) {
      expect(name).toBe(CONNECTORS_SQL_DB_NAME);
      return {
        async query(statement: string, params: unknown[] = []) {
          if (state.down) return refuse();
          try { return { ok: true, data: { rows: sqlite.prepare(statement).all(...params as never[]).map((r) => Object.values(r as object)) } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
        async execute(statement: string, params: unknown[] = []) {
          if (state.down) return refuse();
          try { return { ok: true, data: { changes: sqlite.prepare(statement).run(...params as never[]).changes } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
      };
    },
  };
  const kv = {
    async put(key: string, value: unknown, options?: { ifNoneMatch?: string }) {
      if (state.down) return refuse();
      if (options?.ifNoneMatch === "*" && values.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "412" } };
      values.set(key, value);
      return { ok: true, data: {} };
    },
    async get(key: string) {
      if (state.down) return refuse();
      return values.has(key) ? { ok: true, data: { data: values.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
    },
    async list({ path }: { path: string }) {
      if (state.down) return refuse();
      return { ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)), truncated: false } };
    },
  };
  const tcw = { did, spaceId: did, sql, kv } as unknown as TinyCloudWeb;
  /** Every audio byte the space holds for a note, in part order. */
  const audioBytes = (id: string): number => [...values.entries()]
    .filter(([key, value]) => key.includes("/audio/") && key.includes(id) && value instanceof Uint8Array)
    .reduce((sum, [, value]) => sum + (value as Uint8Array).byteLength, 0);
  return { tcw, did, state, audioBytes };
}

/** The Tauri commands over recordings that exist only as sizes: their bytes are made when read. */
class FakeBridge implements DesktopBridge {
  sizes = new Map<string, number>();
  current: string | null = null;
  state: "idle" | "recording" = "idle";
  elapsed = 0;
  now = Date.now();
  stopped: { id: string; startedAt: number; recordedMs: number; pausedMs: number; maxDurationMs: number }[] = [];
  /** Audio bytes that crossed the bridge (read_audio_chunk). */
  bytesRead = 0;
  listeners = new Map<string, Set<(payload: never) => void>>();
  emit(event: string, payload: unknown) { for (const callback of this.listeners.get(event) ?? []) callback(payload as never); }
  status() {
    return { state: this.state, reason: null, id: this.current, startedAt: this.current ? this.now : null,
      elapsedMs: this.elapsed, audioMs: this.elapsed, channels: 2, pausedMs: 0, maxDurationMs: 3 * 60 * 60_000,
      intent: this.state === "idle" ? "stopped" : "recording", availability: "available", at: this.now, elapsedAt: this.now,
      spans: [], captureSourceUnconfirmed: false, discardCleanupPending: false };
  }
  async listen<T>(event: string, callback: (payload: T) => void): Promise<() => void> {
    const set = this.listeners.get(event) ?? new Set();
    set.add(callback as (payload: never) => void);
    this.listeners.set(event, set);
    return () => set.delete(callback as (payload: never) => void);
  }
  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = String(args.id ?? "");
    let result: unknown = null;
    switch (command) {
      case "recorder_models_get": result = MODEL; break;
      case "recorder_models_list": result = [{ id: MODEL, downloaded: true }]; break;
      case "recorder_recover": result = { journal: null, stopped: this.stopped, quarantined: [] }; break;
      case "recorder_stopped_list": result = this.stopped.map((entry) => entry.id); break;
      case "recorder_failed_list": result = []; break;
      case "recorder_acknowledge": this.stopped = this.stopped.filter((entry) => entry.id !== id); break;
      case "recorder_status": result = this.status(); break;
      case "recorder_list_inputs": result = { inputs: [{ id: "mic-1", name: "Fixture microphone", kind: "built_in" }],
        selectedId: null, activeId: "mic-1", selectedMissing: null }; break;
      case "recorder_set_max_duration": case "recorder_select_input": break;
      case "recorder_start":
        this.current = id; this.state = "recording"; result = this.status();
        this.emit("exo://recorder-mic-state", result); break;
      case "recorder_stop_durable":
        if (this.current) this.stopped.push({ id: this.current, startedAt: this.now, recordedMs: this.elapsed, pausedMs: 0,
          maxDurationMs: 3 * 60 * 60_000 });
        // falls through
      case "recorder_stop":
        result = { ...this.status(), state: "idle", intent: "stopped", reason: null };
        this.state = "idle"; this.current = null; this.elapsed = 0;
        this.emit("exo://recorder-mic-state", this.status()); break;
      case "recorder_finish": case "audio_file_size": case "finalize_audio_file": result = this.sizes.get(id) ?? 0; break;
      case "read_audio_chunk": {
        const offset = Number(args.offset);
        const len = Number(args.len);
        // The native command's own limit (files.rs MAX_CHUNK).
        if (len > ONE_NATIVE_READ) throw new Error("audio_chunk_too_large");
        const bytes = bytesAt(offset, Math.max(0, Math.min(len, (this.sizes.get(id) ?? 0) - offset)));
        this.bytesRead += bytes.byteLength;
        result = bytes; break;
      }
      // Staging copies the file natively: no audio crosses the bridge.
      case "recorder_whisper_stage_audio": this.sizes.set(String(args.stageId), this.sizes.get(id) ?? 0); break;
      case "recorder_whisper_cleanup_stages":
        for (const key of [...this.sizes.keys()]) if (key.startsWith("whisper-")) this.sizes.delete(key);
        result = 0; break;
      case "delete_audio_file": this.sizes.delete(id); break;
      default: throw new Error(`Unexpected command ${command}`);
    }
    return result as T;
  }
}

class FakeWhisper implements DesktopWhisperBridge {
  serverScope = {};
  starts: string[] = [];
  listeners = new Set<(event: TranscriptionEvent) => void>();
  async startServer() { return "http://127.0.0.1:0"; }
  async stopServer() {}
  async onTranscription(cb: (event: TranscriptionEvent) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  async startTranscription(params: { id: string }) { this.starts.push(params.id); }
  async stopTranscription(id: string) { this.emit({ type: "stopped", session_id: id } as TranscriptionEvent); }
  complete(id: string) {
    this.emit({ type: "completed", session_id: id, mode: "direct",
      response: { metadata: null, results: { channels: [{ alternatives: [{ transcript: "Book the venue for Friday", confidence: 1 }] }] } } } as TranscriptionEvent);
  }
  emit(event: TranscriptionEvent) { for (const cb of [...this.listeners]) cb(event); }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await act(async () => { await Bun.sleep(5); });
  }
  return false;
}

/** The length of every read of the recording's audio the page asked its store for. */
function counted(audio: AudioBlobStore, reads: number[]): AudioBlobStore {
  return { ...audio, read: (id, offset, length) => { reads.push(length); return audio.read(id, offset, length); } };
}

interface World {
  space: ReturnType<typeof space>;
  bridge: FakeBridge;
  whisper: FakeWhisper;
  store: WebStore;
  reads: number[];
  engine: Awaited<ReturnType<typeof openDesktopVoiceNotes>>;
  recorder: ReturnType<typeof createVoiceNoteRecorderController>;
  pipeline: ReturnType<typeof createVoiceNotePipeline>;
  host: HTMLElement;
  root: Root;
  close(): Promise<void>;
}

async function world(options: { spaceDown: boolean; uploadAudio: boolean }): Promise<World> {
  const s = space();
  const bridge = new FakeBridge();
  const whisper = new FakeWhisper();
  const reads: number[] = [];
  const store = await openWebStore({ env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null,
    audio: () => counted(createFileAudioBlobStore(bridge), reads) });
  // Signed in from before: the account and the space's identity are known on this Mac.
  const boot = await openDesktopVoiceNotes({ bridge, whisper, now: () => bridge.now, store });
  await boot.plugin.setCaptureDefaults({ accountDid: s.did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false,
    uploadAudio: options.uploadAudio });
  boot.dispose();
  registerDesktopWhisperQueue(null);
  expect((await ensureVoiceNoteIdentity(s.tcw)).status).toBe("established");
  s.state.down = options.spaceDown;
  // As installDesktopEngine does at launch, then the app's recorder and its save pass.
  const engine = await openDesktopVoiceNotes({ bridge, whisper, now: () => bridge.now, store });
  installVoiceNotesEngine(engine.plugin);
  __setInstalledEngineForTests("tauri", engine.plugin.capabilities);
  pendingStore.setAccount(s.did);
  const booted = (async () => { await engine.recoverInterrupted(); await engine.whisper?.resume(); })();
  const pipeline = createVoiceNotePipeline(s.tcw, TIMING);
  const recorder = createVoiceNoteRecorderController({ tcw: s.tcw, available: true, transcriber: null, pipeline, onDeviceReady: () => true });
  const detach = recorder.attach();
  const ctx = { did: s.did, spaceId: s.did, generation: currentAccountGeneration() };
  void booted.then(() => pipeline.reconcileAll(ctx, "reconcile")).catch(() => undefined);
  await booted;
  expect(await waitFor(() => recorder.getState().ready)).toBe(true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return { space: s, bridge, whisper, store, reads, engine, recorder, pipeline, host, root,
    async close() {
      await act(async () => root.unmount());
      host.remove();
      detach(); pipeline.cancelAll(); engine.dispose();
      registerDesktopWhisperQueue(null);
      pendingStore.setAccount(null);
      store.close();
    } };
}

/** Records for two hours (as the native recorder reports it) and stops through the controller, as Done does. */
async function recordAndStop(w: World, bytes: number): Promise<string> {
  w.recorder.dismissOutcome();
  await w.recorder.record();
  const id = w.bridge.current!;
  expect(id).toBeTruthy();
  w.bridge.sizes.set(id, bytes);
  w.bridge.elapsed = TWO_HOURS_MS;
  w.bridge.bytesRead = 0;
  w.reads.length = 0;
  await w.recorder.stop();
  return id;
}

/** The receipt the Mac shows after Stop, wired as RecordingOverlay wires it, over the controller's state. */
function MacReceipt() {
  return <ReceiptView recorder={useRecorder()} />;
}
async function showReceipt(w: World): Promise<void> {
  const state = w.recorder.getState();
  expect(state.outcome).not.toBeNull();
  await act(async () => w.root.render(
    <PlatformContext.Provider value="tauri">
      <StaticRecorderProvider value={{ tcw: w.space.tcw, phase: "idle", outcome: state.outcome, lastSaved: state.lastSaved,
        localUpload: state.localUpload, sheetOpen: true, pending: pendingStore.snapshot() }}>
        <MemoryRouter><MacReceipt /></MemoryRouter>
      </StaticRecorderProvider>
    </PlatformContext.Provider>,
  ));
}

const playButton = (w: World) => w.host.querySelector<HTMLButtonElement>('[data-testid="note-audio-play"]');
const largest = (reads: readonly number[]) => reads.reduce((max, length) => Math.max(max, length), 0);
const pendingOf = async (id: string): Promise<VoiceNoteRecording | undefined> =>
  (await VoiceNotes.listPending()).recordings.find((note) => note.id === id);

let cleanDom: (() => void) | undefined;
let current: World | null = null;
const created: Blob[] = [];
const createObjectURL = URL.createObjectURL;
beforeEach(() => {
  cleanDom = installDom({});
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {
    metadata: { currentWindow: { label: "main" } }, transformCallback: () => 1, invoke: async () => 1 } });
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { configurable: true, value: { unregisterListener: () => undefined } });
  created.length = 0;
  URL.createObjectURL = (blob: Blob | MediaSource) => { created.push(blob as Blob); return createObjectURL(blob as Blob); };
});
afterEach(async () => {
  URL.createObjectURL = createObjectURL;
  if (current) await current.close();
  current = null;
  __resetCaptureEngineForTests();
  cleanDom?.();
});

describe("a two-hour Mac recording, audio upload off, the space unreachable", () => {
  test("Stop reads none of the recording into the page: the receipt shows Play once the Mac has finished the file", async () => {
    const w = current = await world({ spaceDown: true, uploadAudio: false });
    const id = await recordAndStop(w, TWO_HOURS_BYTES);
    await showReceipt(w);
    // The Mac finishes the file, the Whisper job starts on its staged copy, and the receipt offers Play.
    expect(await waitFor(() => w.whisper.starts.includes(id))).toBe(true);
    expect(await waitFor(() => playButton(w) !== null)).toBe(true);
    await act(async () => { await Bun.sleep(50); });
    expect({ largestRead: largest(w.reads) }).toEqual({ largestRead: 0 });
    expect({ audioBytesThroughTheBridge: w.bridge.bytesRead }).toEqual({ audioBytesThroughTheBridge: 0 });
    // Nothing was lost: the note is on this Mac, whole, and waits for the space.
    expect(await pendingOf(id)).toMatchObject({ id, sizeBytes: TWO_HOURS_BYTES, ledger: { localAudio: { state: "ready" } } });
  }, SLOW);

  test("Play reads it in parts no larger than one native read, and plays every byte of it", async () => {
    const w = current = await world({ spaceDown: true, uploadAudio: false });
    const id = await recordAndStop(w, TWO_HOURS_BYTES);
    await showReceipt(w);
    expect(await waitFor(() => playButton(w) !== null)).toBe(true);
    await act(async () => { playButton(w)!.click(); });
    const audio = () => w.host.querySelector<HTMLAudioElement>('[data-testid="note-audio-player"]');
    expect(await waitFor(() => (audio()?.getAttribute("src") ?? "").startsWith("blob:"), 30_000)).toBe(true);
    expect(w.reads.length).toBeGreaterThan(1);
    expect(largest(w.reads)).toBeLessThanOrEqual(ONE_NATIVE_READ);
    expect(w.bridge.bytesRead).toBe(TWO_HOURS_BYTES);
    // The player's source is the recording, byte for byte, at the start, across part boundaries and at the end.
    expect(created).toHaveLength(1);
    const blob = created[0]!;
    expect(blob.size).toBe(TWO_HOURS_BYTES);
    for (const at of [0, MiB - 3, 4 * MiB - 1, 17 * MiB + 5, TWO_HOURS_BYTES - 7]) {
      expect([...new Uint8Array(await blob.slice(at, at + 7).arrayBuffer())]).toEqual([...bytesAt(at, 7)]);
    }
    // A second Play (the note page's) is the same audio: nothing is read again.
    const before = w.bridge.bytesRead;
    expect((await VoiceNotes.localAudioUrl({ id })).url).toBe(audio()!.getAttribute("src")!);
    expect(w.bridge.bytesRead).toBe(before);
  }, SLOW);

  test("the file store refuses a read the size of a recording rather than serve it whole", async () => {
    const w = current = await world({ spaceDown: true, uploadAudio: false });
    const id = await recordAndStop(w, TWO_HOURS_BYTES);
    expect(await waitFor(async () => (await pendingOf(id))?.ledger?.localAudio?.state === "ready")).toBe(true);
    await expect(w.store.audio.read(id, 0, TWO_HOURS_BYTES)).rejects.toThrow("audio_read_too_large");
    expect(w.bridge.bytesRead).toBe(0);
    expect((await w.store.audio.read(id, TWO_HOURS_BYTES - LARGEST_STORE_READ, LARGEST_STORE_READ)).byteLength).toBe(LARGEST_STORE_READ);
  }, SLOW);
});

describe("a long Mac recording, audio upload on, the space reachable", () => {
  test("the upload reads it in parts no larger than one native read, and the space gets every byte", async () => {
    localStorage.setItem("exo.voiceNotes.uploadAudio", "1");
    const w = current = await world({ spaceDown: false, uploadAudio: true });
    const size = 9 * MiB + 123;
    const id = await recordAndStop(w, size);
    expect(await waitFor(() => w.whisper.starts.includes(id))).toBe(true);
    await act(async () => w.whisper.complete(id));
    expect(await waitFor(async () => (await pendingOf(id))?.ledger?.audio.state === "saved", 30_000)).toBe(true);
    expect((await pendingOf(id))?.ledger?.audio.verifiedInSpace).toMatchObject({ size });
    expect(w.space.audioBytes(id)).toBe(size);
    expect(w.reads.length).toBeGreaterThan(1);
    expect(largest(w.reads)).toBeLessThanOrEqual(ONE_NATIVE_READ);
  }, SLOW);
});
