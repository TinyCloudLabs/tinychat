import { describe, expect, test } from "bun:test";
import { base64ToBytes } from "../voiceNoteAudio";
import { newIdbEnv } from "../web/testing/idb";
import { memoryLocks, openWebStore, type WebStoreOptions } from "../web/webStore";
import type { IdbEnv } from "../web/idb";
import { createFileAudioBlobStore } from "./fileAudioBlobStore";
import { openDesktopVoiceNotes, refreshDesktopWhisperCapability, type DesktopBridge } from "./desktopVoiceNotes";
import type { DesktopWhisperBridge } from "./desktopWhisper";
import type { TranscriptionEvent, TranscriptionParams } from "@/lib/anarlog/transcription.gen";
import type { MissingAudioSpan } from "../nativeVoiceNotes";

type Callback = (payload: never) => void;

class FakeBridge implements DesktopBridge {
  files = new Map<string, Uint8Array>();
  calls: string[] = [];
  listeners = new Map<string, Set<Callback>>();
  recover: { id: string; startedAt: number; recordedMs: number; pausedMs: number; maxDurationMs: number;
    spans?: MissingAudioSpan[] } | null = null;
  failed: { id: string; segmentId: string; reason: string; error: string; journal: NonNullable<FakeBridge["recover"]> }[] = [];
  elapsed = 0;
  paused = 0;
  current: string | null = null;
  state: "idle" | "recording" | "paused" = "idle";
  selectedId: string | null = null;
  selectedModel: string | null = null;
  downloadedModels = new Set<string>();
  spans: MissingAudioSpan[] = [];
  stopError: Error | null = null;
  now = 1_000_000;

  emit(event: string, payload: unknown) {
    for (const callback of this.listeners.get(event) ?? []) callback(payload as never);
  }
  status() {
    return { state: this.state, reason: this.state === "paused" ? "user" : null, id: this.current,
      startedAt: this.current ? this.now : null, elapsedMs: this.elapsed, audioMs: this.elapsed,
      pausedMs: this.paused, maxDurationMs: 10_000, intent: this.state === "idle" ? "stopped" : this.state,
      availability: "available", at: this.now, elapsedAt: this.now, spans: this.spans };
  }
  async listen<T>(event: string, callback: (payload: T) => void): Promise<() => void> {
    const set = this.listeners.get(event) ?? new Set<Callback>();
    set.add(callback as Callback);
    this.listeners.set(event, set);
    return () => set.delete(callback as Callback);
  }
  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(command);
    const id = String(args.id ?? "");
    let result: unknown;
    switch (command) {
      case "recorder_models_get": result = this.selectedModel; break;
      case "recorder_models_list": result = [...this.downloadedModels].map((model) => ({ id: model, downloaded: true })); break;
      case "recorder_models_select": this.selectedModel = id;
        this.emit("exo://recorder-model-selection", id); result = null; break;
      case "recorder_recover": result = { journal: this.recover, quarantined: this.failed }; break;
      case "recorder_acknowledge": this.recover = null; result = null; break;
      case "recorder_failed_list": result = this.failed; break;
      case "recorder_failed_retry": this.failed = this.failed.filter((item) => item.id !== id); result = []; break;
      case "recorder_failed_delete": this.failed = this.failed.filter((item) => item.id !== id); result = null; break;
      case "recorder_start": if (this.recover) throw new Error("recovery_pending");
        this.current = id; this.state = "recording"; result = this.status(); this.emit("exo://recorder-mic-state", result); break;
      case "recorder_pause": this.state = "paused"; result = this.status(); this.emit("exo://recorder-mic-state", result); break;
      case "recorder_resume": this.state = "recording"; result = this.status(); this.emit("exo://recorder-mic-state", result); break;
      case "recorder_stop": if (this.stopError) throw this.stopError;
        result = { ...this.status(), state: "idle", intent: "stopped" };
        this.state = "idle"; this.current = null; this.elapsed = 0; this.paused = 0;
        this.emit("exo://recorder-mic-state", this.status()); break;
      case "recorder_status": result = this.status(); break;
      case "recorder_list_inputs": result = { inputs: [{ id: "mic-1", name: "Fixture microphone", kind: "built_in" }],
        selectedId: this.selectedId, activeId: this.state === "recording" ? this.selectedId : null }; break;
      case "recorder_select_input": this.selectedId = args.id as string | null; result = null; break;
      case "audio_file_size": result = this.files.get(id)?.length ?? 0; break;
      case "append_audio_chunk": {
        const old = this.files.get(id) ?? new Uint8Array();
        const next = Uint8Array.from(args.bytes as number[]);
        const together = new Uint8Array(old.length + next.length);
        together.set(old); together.set(next, old.length);
        this.files.set(id, together); result = together.length; break;
      }
      case "read_audio_chunk": result = (this.files.get(id) ?? new Uint8Array()).slice(Number(args.offset), Number(args.offset) + Number(args.len)); break;
      case "finalize_audio_file": result = this.files.get(id)?.length ?? 0; break;
      case "recorder_whisper_stage_audio": {
        const stageId = String(args.stageId);
        this.files.set(stageId, (this.files.get(id) ?? new Uint8Array()).slice());
        result = `/fixture/${stageId}.mp3`;
        break;
      }
      case "recorder_whisper_cleanup_stages": {
        let removed = 0;
        for (const key of this.files.keys()) if (key.startsWith("whisper-")) {
          this.files.delete(key); removed++;
        }
        result = removed;
        break;
      }
      case "delete_audio_file": this.files.delete(id);
        this.failed = this.failed.filter((item) => item.id !== id);
        result = null; break;
      default: throw new Error(`Unexpected command ${command}`);
    }
    return result as T;
  }
}

class FakeWhisper implements DesktopWhisperBridge {
  calls: TranscriptionParams[] = [];
  stops: string[] = [];
  serverStops = 0;
  serverStarts = 0;
  onStopServer: (() => void) | null = null;
  fail = false;
  pending = false;
  listeners = new Set<(event: TranscriptionEvent) => void>();
  async startServer() { this.serverStarts++; return "http://fixture"; }
  async stopServer() { this.serverStops++; this.onStopServer?.(); }
  async onTranscription(cb: (event: TranscriptionEvent) => void) {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  async startTranscription(params: TranscriptionParams) {
    this.calls.push(params);
    if (this.pending) return;
    queueMicrotask(() => this.emit(this.fail
      ? { type: "failed", session_id: params.session_id, code: "unknown", error: "fixture failed" }
      : { type: "completed", session_id: params.session_id, mode: "direct",
        response: { metadata: null, results: { channels: [{ alternatives: [{ transcript: "hello", confidence: 1 }] }] } } }));
  }
  async stopTranscription(id: string) { this.stops.push(id); this.emit({ type: "stopped", session_id: id }); }
  emit(event: TranscriptionEvent) { for (const cb of this.listeners) cb(event); }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (check()) return; await Bun.sleep(10); }
  throw new Error("Timed out waiting for fixture Whisper");
}

const slow = (name: string, run: () => Promise<void>) => test(name, run, 30_000);

function rig(bridge = new FakeBridge(), dbName = crypto.randomUUID(), env: IdbEnv = newIdbEnv(),
  storeOptions: Partial<WebStoreOptions> = {}, id = "note-1") {
  return openDesktopVoiceNotes({ bridge, now: () => bridge.now, newId: () => id,
    storeOptions: { env, dbName, locks: memoryLocks(), decodeCheck: null, now: () => bridge.now, ...storeOptions } });
}

describe("desktop recorder adapter", () => {
  slow("stop queues Whisper and commits a local transcript once", async () => {
    const bridge = new FakeBridge();
    bridge.selectedModel = "QuantizedTinyEn";
    bridge.downloadedModels.add("QuantizedTinyEn");
    const whisper = new FakeWhisper();
    const engine = await openDesktopVoiceNotes({ bridge, whisper, now: () => bridge.now,
      storeOptions: { env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null } });
    const id = (await engine.plugin.start()).id;
    bridge.files.set(id, Uint8Array.of(1, 2, 3));
    bridge.elapsed = 1000;
    await engine.plugin.stop();
    await waitFor(() => engine.whisper?.snapshot().get(id)?.state === "done");
    await waitFor(() => whisper.serverStops === 1);
    expect(whisper.calls).toHaveLength(1);
    expect((await engine.plugin.getTranscript({ id })).transcript).toMatchObject({ engine: "whispercpp", outcome: "transcribed",
      segments: [{ text: "hello" }] });
    const completed: string[] = [];
    const stopDone = engine.whisper!.onDone((doneId) => completed.push(doneId));
    await waitFor(() => completed.length === 1);
    expect(completed).toEqual([id]);
    stopDone();
    await engine.whisper!.resume();
    expect(whisper.calls).toHaveLength(1);
    engine.dispose();
  });

  slow("Whisper progress is visible on the queued note", async () => {
    const bridge = new FakeBridge();
    bridge.selectedModel = "QuantizedTinyEn";
    bridge.downloadedModels.add("QuantizedTinyEn");
    const whisper = new FakeWhisper();
    whisper.pending = true;
    const engine = await openDesktopVoiceNotes({ bridge, whisper, now: () => bridge.now,
      storeOptions: { env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null } });
    const id = (await engine.plugin.start()).id;
    bridge.files.set(id, Uint8Array.of(1, 2));
    await engine.plugin.stop();
    await waitFor(() => whisper.calls.length === 1);
    await expect(engine.whisper!.retry(id)).rejects.toThrow("already being transcribed");
    whisper.emit({ type: "progress", session_id: id,
      event: { type: "progress", percentage: 0.5, partial_text: "halfway" } });
    await waitFor(() => engine.whisper?.snapshot().get(id)?.progress === 50);
    expect((await engine.plugin.listPending()).recordings.find((note) => note.id === id)?.stt?.state).toBe("running");
    whisper.emit({ type: "completed", session_id: id, mode: "direct",
      response: { metadata: null, results: { channels: [{ alternatives: [{ transcript: "hello", confidence: 1 }] }] } } });
    await waitFor(() => engine.whisper?.snapshot().get(id)?.state === "done");
    engine.dispose();
  });

  slow("Off and private-cloud notes never start Whisper", async () => {
    const bridge = new FakeBridge();
    bridge.selectedModel = "QuantizedTinyEn";
    bridge.downloadedModels.add("QuantizedTinyEn");
    const whisper = new FakeWhisper();
    const engine = await openDesktopVoiceNotes({ bridge, whisper, now: () => bridge.now,
      storeOptions: { env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null } });
    await engine.plugin.setAccountState({ status: "signed_in", accountDid: "did:owner", transitionGen: 1 });
    await engine.plugin.setCaptureDefaults({ accountDid: "did:owner", transitionGen: 1,
      transcriber: "off", identifySpeakers: false });
    for (const route of ["off", "private-cloud"] as const) {
      const id = (await engine.plugin.start({ transcriber: route })).id;
      bridge.files.set(id, Uint8Array.of(1, 2));
      bridge.elapsed = 1000;
      expect((await engine.plugin.stop()).options?.transcriber).toBe(route);
    }
    await engine.whisper!.resume();
    expect(whisper.calls).toHaveLength(0);
    engine.dispose();
  });

  slow("starting another recording stops Whisper before opening the microphone", async () => {
    const bridge = new FakeBridge();
    bridge.selectedModel = "QuantizedTinyEn";
    bridge.downloadedModels.add("QuantizedTinyEn");
    const whisper = new FakeWhisper();
    whisper.pending = true;
    whisper.onStopServer = () => expect(bridge.state).toBe("idle");
    const engine = await openDesktopVoiceNotes({ bridge, whisper, now: () => bridge.now,
      storeOptions: { env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null } });
    const first = (await engine.plugin.start()).id;
    bridge.files.set(first, Uint8Array.of(1));
    bridge.elapsed = 1000;
    await engine.plugin.stop();
    await waitFor(() => whisper.calls.length === 1);
    const second = (await engine.plugin.start()).id;
    expect(second).not.toBe(first);
    expect((await engine.plugin.status()).state).toBe("recording");
    expect(whisper.serverStops).toBeGreaterThan(0);
    await waitFor(() => whisper.listeners.size === 0);
    whisper.onStopServer = null;
    await engine.plugin.discard();
    engine.dispose();
  });

  slow("a 15 second model load never delays a new recording", async () => {
    const bridge = new FakeBridge();
    bridge.selectedModel = "QuantizedTinyEn";
    bridge.downloadedModels.add("QuantizedTinyEn");
    const whisper = new FakeWhisper();
    let finishLoad: (url: string) => void = () => {};
    whisper.startServer = async () => {
      whisper.serverStarts++;
      return new Promise<string>((resolve) => { finishLoad = resolve; });
    };
    const engine = await openDesktopVoiceNotes({ bridge, whisper, now: () => bridge.now,
      storeOptions: { env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null } });
    const first = (await engine.plugin.start()).id;
    bridge.files.set(first, Uint8Array.of(1));
    bridge.elapsed = 1000;
    await engine.plugin.stop();
    await waitFor(() => whisper.serverStarts === 1);
    const second = await Promise.race([engine.plugin.start(), Bun.sleep(500).then(() => { throw new Error("Record waited for Whisper"); })]);
    expect(second.id).not.toBe(first);
    expect(whisper.serverStops).toBeGreaterThan(0);
    bridge.now += 15_000;
    finishLoad("http://fixture");
    await waitFor(() => whisper.serverStops >= 2);
    await waitFor(() => engine.whisper?.snapshot().get(first)?.state === "queued");
    expect((await engine.plugin.status()).state).toBe("recording");
    await engine.plugin.discard();
    engine.dispose();
  });

  slow("native Whisper cancellation errors never reject Record", async () => {
    const bridge = new FakeBridge();
    bridge.selectedModel = "QuantizedTinyEn";
    bridge.downloadedModels.add("QuantizedTinyEn");
    const whisper = new FakeWhisper();
    whisper.pending = true;
    whisper.stopServer = async () => { throw new Error("server already stopped"); };
    whisper.stopTranscription = async () => { throw new Error("task already stopped"); };
    const engine = await openDesktopVoiceNotes({ bridge, whisper,
      storeOptions: { env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null } });
    const first = (await engine.plugin.start()).id;
    bridge.files.set(first, Uint8Array.of(1));
    await engine.plugin.stop();
    await waitFor(() => whisper.calls.length === 1);
    await expect(engine.plugin.start()).resolves.toHaveProperty("id");
    expect((await engine.plugin.status()).state).toBe("recording");
    await engine.plugin.discard();
    engine.dispose();
  });

  slow("a model failure during transcription fails promptly", async () => {
    const bridge = new FakeBridge();
    bridge.selectedModel = "QuantizedTinyEn";
    bridge.downloadedModels.add("QuantizedTinyEn");
    const whisper = new FakeWhisper();
    whisper.pending = true;
    const engine = await openDesktopVoiceNotes({ bridge, whisper,
      storeOptions: { env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null } });
    const id = (await engine.plugin.start()).id;
    bridge.files.set(id, Uint8Array.of(1, 2));
    await engine.plugin.stop();
    await waitFor(() => whisper.calls.length === 1);
    bridge.downloadedModels.clear();
    whisper.emit({ type: "failed", session_id: id, code: "unknown", error: "Whisper model disappeared" });
    await waitFor(() => engine.whisper?.snapshot().get(id)?.state === "failed");
    expect(engine.whisper?.snapshot().get(id)?.error).toContain("model disappeared");
    engine.dispose();
  });

  slow("Whisper failure stays on the note until Retry; a missing model reports unavailable", async () => {
    const bridge = new FakeBridge();
    bridge.selectedModel = "QuantizedTinyEn";
    bridge.downloadedModels.add("QuantizedTinyEn");
    const whisper = new FakeWhisper();
    whisper.fail = true;
    const engine = await openDesktopVoiceNotes({ bridge, whisper, now: () => bridge.now,
      storeOptions: { env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null } });
    const id = (await engine.plugin.start()).id;
    bridge.files.set(id, Uint8Array.of(1, 2, 3));
    bridge.elapsed = 1000;
    await engine.plugin.stop();
    await waitFor(() => engine.whisper?.snapshot().get(id)?.state === "failed");
    expect((await engine.plugin.listPending()).recordings.find((note) => note.id === id)?.stt?.error).toContain("fixture failed");
    whisper.fail = false;
    await engine.whisper!.retry(id);
    await waitFor(() => engine.whisper?.snapshot().get(id)?.state === "done");
    expect(whisper.calls).toHaveLength(2);
    engine.dispose();

    const missing = new FakeBridge();
    missing.selectedModel = "QuantizedTinyEn";
    const missingWhisper = new FakeWhisper();
    const absent = await openDesktopVoiceNotes({ bridge: missing, whisper: missingWhisper,
      storeOptions: { env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null } });
    await absent.plugin.setAccountState({ status: "signed_in", accountDid: "did:owner", transitionGen: 1 });
    await absent.plugin.setCaptureDefaults({ accountDid: "did:owner", transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false });
    const missingId = (await absent.plugin.start({ transcriber: "on-device" })).id;
    missing.files.set(missingId, Uint8Array.of(1));
    await absent.plugin.stop();
    await waitFor(() => absent.whisper?.snapshot().get(missingId)?.state === "failed");
    expect(absent.whisper?.snapshot().get(missingId)?.error).toContain("unavailable");
    expect(missingWhisper.calls).toHaveLength(0);
    missing.downloadedModels.add("QuantizedTinyEn");
    await missing.invoke("recorder_models_select", { id: "QuantizedTinyEn" });
    await waitFor(() => absent.whisper?.snapshot().get(missingId)?.state === "done");
    expect(missingWhisper.calls).toHaveLength(1);
    absent.dispose();
  });

  slow("relaunch requeues interrupted Whisper without making a duplicate transcript", async () => {
    const bridge = new FakeBridge();
    bridge.selectedModel = "QuantizedTinyEn";
    bridge.downloadedModels.add("QuantizedTinyEn");
    const env = newIdbEnv();
    const dbName = crypto.randomUUID();
    const firstWhisper = new FakeWhisper();
    firstWhisper.pending = true;
    const first = await openDesktopVoiceNotes({ bridge, whisper: firstWhisper, now: () => bridge.now,
      storeOptions: { env, dbName, locks: memoryLocks(), decodeCheck: null } });
    const id = (await first.plugin.start()).id;
    bridge.files.set(id, Uint8Array.of(1, 2));
    bridge.elapsed = 1000;
    await first.plugin.stop();
    await waitFor(() => firstWhisper.calls.length === 1);
    first.dispose();
    const nextWhisper = new FakeWhisper();
    const next = await openDesktopVoiceNotes({ bridge, whisper: nextWhisper, now: () => bridge.now,
      storeOptions: { env, dbName, locks: memoryLocks(), decodeCheck: null } });
    await expect(next.whisper!.retry(id)).rejects.toThrow("already being transcribed");
    await next.whisper!.resume();
    await waitFor(() => next.whisper?.snapshot().get(id)?.state === "done");
    expect(nextWhisper.stops).toEqual([id]);
    expect(nextWhisper.calls).toHaveLength(1);
    next.dispose();
    const third = await openDesktopVoiceNotes({ bridge, whisper: new FakeWhisper(), now: () => bridge.now,
      storeOptions: { env, dbName, locks: memoryLocks(), decodeCheck: null } });
    await third.whisper!.resume();
    expect((await third.plugin.listPending()).recordings.filter((note) => note.id === id)).toHaveLength(1);
    expect((await third.plugin.getTranscript({ id })).transcript?.noteId).toBe(id);
    third.dispose();
  });
  test("reopens a live native capture after WebView reload and can stop it", async () => {
    const bridge = new FakeBridge();
    const env = newIdbEnv();
    const dbName = crypto.randomUUID();
    const first = await rig(bridge, dbName, env);
    await first.plugin.start();
    bridge.elapsed = 1_500;
    bridge.files.set("note-1", Uint8Array.of(1, 2, 3));
    first.dispose();
    const reopened = await rig(bridge, dbName, env);
    const recovery = await reopened.recoverInterrupted();
    expect(recovery.recovered).toHaveLength(0);
    expect(bridge.calls).not.toContain("recorder_recover");
    expect((await reopened.plugin.status()).elapsedMs).toBe(1_500);
    const note = await reopened.plugin.stop();
    expect(note.id).toBe("note-1");
    expect(note.durationMs).toBe(1_500);
    reopened.dispose();
  });

  test("native import failure enters quarantine and can be discarded", async () => {
    const bridge = new FakeBridge();
    const engine = await rig(bridge);
    await engine.plugin.start();
    bridge.failed = [{ id: "note-1", segmentId: "rec-broken", reason: "write_failed", error: "bad MP3",
      journal: { id: "note-1", startedAt: bridge.now, recordedMs: 0, pausedMs: 0, maxDurationMs: 10_000 } }];
    await expect(engine.plugin.stop()).rejects.toThrow("bad MP3");
    expect((await engine.plugin.listQuarantine()).items).toMatchObject([{ id: "note-1", reason: "write_failed" }]);
    await engine.plugin.discardFailedRecording({ id: "note-1" });
    expect((await engine.plugin.listQuarantine()).items).toHaveLength(0);
    engine.dispose();
  });

  test("discard writes its tombstone before native stop can fail", async () => {
    const bridge = new FakeBridge();
    const env = newIdbEnv();
    const dbName = crypto.randomUUID();
    const engine = await rig(bridge, dbName, env);
    await engine.plugin.start();
    bridge.files.set("note-1", Uint8Array.of(1, 2, 3));
    bridge.stopError = new Error("writer stopped responding");
    await expect(engine.plugin.discard()).rejects.toThrow("writer stopped responding");
    expect((await engine.plugin.listPending()).recordings).toHaveLength(0);
    engine.dispose();
    bridge.stopError = null;
    const reopened = await rig(bridge, dbName, env);
    expect(bridge.state).toBe("idle");
    await reopened.recoverInterrupted();
    expect(bridge.files.has("note-1")).toBe(false);
    reopened.dispose();
  });

  test("an interrupted discard does not resurrect a failed native segment", async () => {
    const bridge = new FakeBridge();
    const env = newIdbEnv();
    const dbName = crypto.randomUUID();
    const first = await rig(bridge, dbName, env);
    await first.plugin.start();
    bridge.files.set("note-1", Uint8Array.of(1, 2, 3));
    bridge.stopError = new Error("interrupted stop");
    await expect(first.plugin.discard()).rejects.toThrow("interrupted stop");
    first.dispose();
    bridge.stopError = null;
    bridge.state = "idle"; bridge.current = null;
    const journal = { id: "note-1", startedAt: bridge.now, recordedMs: 500,
      pausedMs: 0, maxDurationMs: 10_000 };
    bridge.recover = journal;
    bridge.failed = [{ id: "note-1", segmentId: "rec-broken", reason: "write_failed",
      error: "bad MP3", journal }];
    const reopened = await rig(bridge, dbName, env);
    const result = await reopened.recoverInterrupted();
    expect(result.recovered).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect((await reopened.plugin.listQuarantine()).items).toHaveLength(0);
    expect(bridge.files.has("note-1")).toBe(false);
    reopened.dispose();
  });
  test("capabilities do not enable the mobile OnDeviceStt plugin", async () => {
    const engine = await rig();
    expect(engine.plugin.capabilities).toMatchObject({ localTranscription: false, background: true,
      offlineRecorder: true, nativeShortcuts: false, presentRecorder: false, openSettings: false });
    engine.dispose();
  });

  test("signed-out capture uses Whisper only with a selected downloaded model", async () => {
    const missing = new FakeBridge();
    missing.selectedModel = "QuantizedTinyEn";
    const audioOnly = await rig(missing);
    expect(audioOnly.plugin.capabilities.desktopWhisper).toBe(false);
    await audioOnly.plugin.start();
    expect((await audioOnly.plugin.status()).options?.transcriber).toBe("off");
    audioOnly.dispose();

    const ready = new FakeBridge();
    ready.selectedModel = "QuantizedTinyEn";
    ready.downloadedModels.add("QuantizedTinyEn");
    const whisper = await rig(ready);
    expect(whisper.plugin.capabilities).toMatchObject({ desktopWhisper: true, localTranscription: false });
    await whisper.plugin.start();
    expect((await whisper.plugin.status()).options?.transcriber).toBe("on-device");
    whisper.dispose();
  });

  test("selecting a downloaded model refreshes desktopWhisper without a reload", async () => {
    const bridge = new FakeBridge();
    bridge.downloadedModels.add("QuantizedTinyEn");
    const engine = await rig(bridge);
    expect(engine.plugin.capabilities.desktopWhisper).toBe(false);
    await bridge.invoke("recorder_models_select", { id: "QuantizedTinyEn" });
    await refreshDesktopWhisperCapability();
    await waitFor(() => engine.plugin.capabilities.desktopWhisper);
    expect((await engine.plugin.start()).id).toBe("note-1");
    expect((await engine.plugin.status()).options?.transcriber).toBe("on-device");
    engine.dispose();
  });

  test("a failed post-start metadata write stops the native microphone", async () => {
    const bridge = new FakeBridge();
    const engine = await rig(bridge, crypto.randomUUID(), newIdbEnv(), { hooks: { beforeOp(op) {
      if (op === "session:update") throw new Error("metadata unavailable");
    } } });
    await expect(engine.plugin.start()).rejects.toThrow("metadata unavailable");
    expect(bridge.calls).toContain("recorder_stop");
    expect(bridge.state).toBe("idle");
    expect((await engine.plugin.listPending()).recordings).toHaveLength(0);
    engine.dispose();
  });

  test("file-backed audio reads in chunks and reports the real size", async () => {
    const bridge = new FakeBridge();
    const audio = createFileAudioBlobStore(bridge);
    expect(await audio.append("note-1", Uint8Array.of(1, 2, 3))).toBe(3);
    expect(await audio.read("note-1", 1, 9)).toEqual(Uint8Array.of(2, 3));
    expect(await audio.finalize("note-1")).toBe(3);
    await audio.delete("note-1");
    expect(await audio.size("note-1")).toBe(0);
  });

  test("start, pause and resume keep elapsed time and committed bytes", async () => {
    const bridge = new FakeBridge();
    const engine = await rig(bridge);
    const seen: string[] = [];
    const levels: { level: number; peak?: number }[] = [];
    await engine.plugin.addListener("micState", (event) => seen.push(event.state));
    await engine.plugin.addListener("level", (event) => levels.push(event));
    const started = await engine.plugin.start({ maxDurationMs: 10_000 });
    expect(started.id).toBe("note-1");
    await engine.plugin.selectInput({ id: "mic-1" });
    expect((await engine.plugin.listInputs()).selectedId).toBe("mic-1");
    bridge.emit("exo://recorder-level", { level: 0.25, peak: 0.5 });
    expect(levels).toEqual([{ level: 0.25, peak: 0.5 }]);
    bridge.elapsed = 1000;
    bridge.files.set(started.id, Uint8Array.of(10, 20));
    await engine.plugin.pause();
    bridge.now += 5000;
    bridge.paused = 5000;
    expect((await engine.plugin.status()).elapsedMs).toBe(1000);
    await engine.plugin.resume();
    bridge.elapsed = 1800;
    bridge.files.set(started.id, Uint8Array.of(10, 20, 30, 40));
    const recording = await engine.plugin.stop();
    expect(recording.durationMs).toBe(1800);
    expect(recording.pausedMs).toBe(5000);
    expect(recording.sizeBytes).toBe(4);
    expect((await engine.plugin.listPending()).recordings).toHaveLength(1);
    expect(base64ToBytes((await engine.plugin.readAudioChunk({ id: started.id, offset: 1, length: 2 })).base64))
      .toEqual(Uint8Array.of(20, 30));
    expect(seen).toContain("paused");
    expect(seen).toContain("recording");
    engine.dispose();
  });

  test("an empty live interval is kept as a stalled omission without adding recorded time", async () => {
    const bridge = new FakeBridge();
    const engine = await rig(bridge);
    await engine.plugin.start();
    bridge.files.set("note-1", Uint8Array.of(1, 2, 3));
    bridge.elapsed = 1_500;
    const span: MissingAudioSpan = { kind: "omitted", reason: "stalled",
      startedAt: bridge.now + 1_500, endedAt: bridge.now + 121_500,
      atAudioMs: 1_500, audioMs: 0 };
    bridge.spans = [span];
    await engine.plugin.pause();
    expect((await engine.plugin.status()).spans).toEqual([span]);
    const recording = await engine.plugin.stop();
    expect(recording.durationMs).toBe(1_500);
    expect(recording.spans).toEqual([span]);
    engine.dispose();
  });

  test("native auto-stop commits once with the terminal elapsed time", async () => {
    const bridge = new FakeBridge();
    const engine = await rig(bridge);
    const committed: unknown[] = [];
    const auto: unknown[] = [];
    await engine.plugin.addListener("committed", (event) => committed.push(event));
    await engine.plugin.addListener("autoStopped", (event) => auto.push(event));
    await engine.plugin.start();
    bridge.files.set("note-1", Uint8Array.of(1, 2, 3));
    bridge.elapsed = 1500;
    await bridge.invoke("recorder_stop");
    bridge.emit("exo://recorder-auto-stopped", { id: "note-1", reason: "max_duration", maxDurationMs: 1500,
      at: bridge.now, elapsedMs: 1500, pausedMs: 0 });
    await engine.plugin.status();
    // Let the serialized native event finish its async commit.
    for (let n = 0; n < 20 && auto.length === 0; n++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(committed).toHaveLength(1);
    expect(auto).toHaveLength(1);
    expect((auto[0] as { recording: { durationMs: number } }).recording.durationMs).toBe(1500);
    engine.dispose();
  });

  test("native interrupted segment imports before shared store recovery", async () => {
    const bridge = new FakeBridge();
    const env = newIdbEnv();
    const dbName = crypto.randomUUID();
    const first = await rig(bridge, dbName, env);
    await first.plugin.start();
    first.dispose();
    bridge.state = "idle"; bridge.current = null;
    bridge.files.set("note-1", Uint8Array.of(1, 2, 3));
    bridge.recover = { id: "note-1", startedAt: bridge.now, recordedMs: 1000, pausedMs: 0, maxDurationMs: 10_000 };
    const second = await rig(bridge, dbName, env);
    const result = await second.recoverInterrupted();
    expect(bridge.calls.indexOf("recorder_recover")).toBeLessThan(bridge.calls.lastIndexOf("finalize_audio_file"));
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.sizeBytes).toBe(3);
    expect((await second.plugin.listPending()).recordings).toHaveLength(1);
    second.dispose();
    // Simulate the renderer dying after commit but before native ACK.
    bridge.recover = { id: "note-1", startedAt: bridge.now, recordedMs: 1000,
      pausedMs: 0, maxDurationMs: 10_000 };
    const third = await rig(bridge, dbName, env);
    expect((await third.recoverInterrupted()).recovered).toHaveLength(0);
    expect((await third.plugin.listPending()).recordings).toHaveLength(1);
    third.dispose();
  });

  test("a native journal restores an empty-interval span after renderer loss", async () => {
    const bridge = new FakeBridge();
    const env = newIdbEnv();
    const dbName = crypto.randomUUID();
    const first = await rig(bridge, dbName, env);
    await first.plugin.start();
    first.dispose();
    bridge.state = "idle"; bridge.current = null;
    bridge.files.set("note-1", Uint8Array.of(1, 2, 3));
    const span: MissingAudioSpan = { kind: "omitted", reason: "stalled",
      startedAt: bridge.now + 1_500, endedAt: bridge.now + 121_500,
      atAudioMs: 1_500, audioMs: 0 };
    bridge.recover = { id: "note-1", startedAt: bridge.now, recordedMs: 1_500,
      pausedMs: 0, maxDurationMs: 10_000, spans: [span] };
    const second = await rig(bridge, dbName, env);
    expect((await second.recoverInterrupted()).recovered[0]?.spans).toEqual([span]);
    expect((await second.plugin.listPending()).recordings[0]?.spans).toEqual([span]);
    second.dispose();
  });

  test("quarantined native recovery acknowledges its journal so another note can start", async () => {
    const bridge = new FakeBridge();
    const env = newIdbEnv();
    const dbName = crypto.randomUUID();
    const first = await rig(bridge, dbName, env);
    await first.plugin.start();
    first.dispose();
    bridge.state = "idle"; bridge.current = null;
    const journal = { id: "note-1", startedAt: bridge.now, recordedMs: 1000, pausedMs: 0, maxDurationMs: 10_000 };
    bridge.recover = journal;
    bridge.failed = [{ id: "note-1", segmentId: "rec-broken", reason: "write_failed", error: "bad MP3", journal }];
    const second = await rig(bridge, dbName, env, {}, "note-2");
    expect((await second.recoverInterrupted()).failed).toMatchObject([{ id: "note-1" }]);
    expect(bridge.recover).toBeNull();
    expect((await second.plugin.start()).id).toBe("note-2");
    second.dispose();
  });

  test("an empty first-second crash clears the native journal across relaunches", async () => {
    const bridge = new FakeBridge();
    const env = newIdbEnv();
    const dbName = crypto.randomUUID();
    const first = await rig(bridge, dbName, env);
    await first.plugin.start();
    first.dispose();
    bridge.state = "idle"; bridge.current = null;
    bridge.recover = { id: "note-1", startedAt: bridge.now, recordedMs: 0,
      pausedMs: 0, maxDurationMs: 10_000 };
    // Native has skipped a header-only/missing capture segment. The Rust file
    // store reports zero bytes, so WebStore drops the empty session.
    const second = await rig(bridge, dbName, env, {}, "note-2");
    expect(await second.recoverInterrupted()).toEqual({ recovered: [], failed: [] });
    expect(bridge.recover).toBeNull();
    expect((await second.plugin.listPending()).recordings).toHaveLength(0);
    expect((await second.plugin.start()).id).toBe("note-2");
    await second.plugin.discard();
    second.dispose();

    const third = await rig(bridge, dbName, env, {}, "note-3");
    expect(await third.recoverInterrupted()).toEqual({ recovered: [], failed: [] });
    expect((await third.plugin.listPending()).recordings).toHaveLength(0);
    expect((await third.plugin.start()).id).toBe("note-3");
    expect(bridge.calls).toContain("recorder_acknowledge");
    third.dispose();
  });

  test("relaunch keeps original quarantine metadata and emits its failure only once", async () => {
    const bridge = new FakeBridge();
    const env = newIdbEnv();
    const dbName = crypto.randomUUID();
    const first = await rig(bridge, dbName, env);
    await first.plugin.setAccountState({ status: "signed_in", accountDid: "did:owner", transitionGen: 1 });
    await first.plugin.setCaptureDefaults({ accountDid: "did:owner", transitionGen: 1,
      transcriber: "assemblyai", identifySpeakers: true });
    await first.plugin.selectInput({ id: "mic-1" });
    await first.plugin.start();
    first.dispose();
    const before = await openWebStore({ env, dbName, locks: memoryLocks(), decodeCheck: null,
      audio: () => createFileAudioBlobStore(bridge) });
    const span = { kind: "omitted" as const, reason: "input_unavailable", startedAt: bridge.now,
      endedAt: bridge.now + 100, atAudioMs: 100, audioMs: 0 };
    await before.updateSession("note-1", { spans: [span] });
    before.close();
    bridge.state = "idle"; bridge.current = null;
    const journal = { id: "note-1", startedAt: bridge.now, recordedMs: 1000, pausedMs: 0, maxDurationMs: 10_000 };
    bridge.recover = journal;
    bridge.failed = [{ id: "note-1", segmentId: "rec-broken", reason: "write_failed", error: "bad MP3", journal }];
    const second = await rig(bridge, dbName, env);
    const firstFailures: unknown[] = [];
    await second.plugin.addListener("recoveryFailed", (event) => firstFailures.push(event));
    await second.recoverInterrupted();
    expect(firstFailures).toHaveLength(1);
    second.dispose();
    const third = await rig(bridge, dbName, env);
    const repeated: unknown[] = [];
    await third.plugin.addListener("recoveryFailed", (event) => repeated.push(event));
    await third.recoverInterrupted();
    expect(repeated).toHaveLength(0);
    expect((await third.plugin.listQuarantine()).items).toHaveLength(1);
    third.dispose();
    const stored = await openWebStore({ env, dbName, locks: memoryLocks(), decodeCheck: null,
      audio: () => createFileAudioBlobStore(bridge) });
    await stored.rearmQuarantined("note-1");
    expect(await stored.getSession("note-1")).toMatchObject({ owner: "did:owner",
      options: { transcriber: "assemblyai", identifySpeakers: true },
      input: { id: "mic-1" }, spans: [span] });
    stored.close();
  });

  test("a signed-out recording is journaled as Audio only until the desktop Whisper route exists", async () => {
    const bridge = new FakeBridge();
    const env = newIdbEnv();
    const dbName = crypto.randomUUID();
    const first = await rig(bridge, dbName, env);
    await first.plugin.start({ transcriber: "on-device" });
    first.dispose();
    const stored = await openWebStore({ env, dbName, locks: memoryLocks(), decodeCheck: null,
      audio: () => createFileAudioBlobStore(bridge) });
    expect(await stored.getSession("note-1")).toMatchObject({ owner: null, options: { transcriber: "off" } });
    stored.close();
  });

  test("a failed metadata commit leaves the durable native file for recovery", async () => {
    const bridge = new FakeBridge();
    const env = newIdbEnv();
    const dbName = crypto.randomUUID();
    let fail = true;
    const first = await rig(bridge, dbName, env, { hooks: { beforeOp(op) {
      if (op === "note:commit" && fail) { fail = false; throw new Error("metadata unavailable"); }
    } } });
    await first.plugin.start();
    bridge.elapsed = 1200;
    bridge.files.set("note-1", Uint8Array.of(8, 9, 10));
    await expect(first.plugin.stop()).rejects.toThrow("metadata unavailable");
    expect(bridge.files.get("note-1")).toEqual(Uint8Array.of(8, 9, 10));
    first.dispose();
    const second = await rig(bridge, dbName, env);
    const result = await second.recoverInterrupted();
    expect(result.recovered[0]).toMatchObject({ id: "note-1", sizeBytes: 3, durationMs: 1200 });
    expect(bridge.files.get("note-1")).toEqual(Uint8Array.of(8, 9, 10));
    second.dispose();
  });
});
