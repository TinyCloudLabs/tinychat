import { describe, expect, test } from "bun:test";
import { base64ToBytes } from "../voiceNoteAudio";
import { newIdbEnv } from "../web/testing/idb";
import { memoryLocks, openWebStore, type WebStoreOptions } from "../web/webStore";
import type { IdbEnv } from "../web/idb";
import { createFileAudioBlobStore } from "./fileAudioBlobStore";
import { openDesktopVoiceNotes, type DesktopBridge } from "./desktopVoiceNotes";

type Callback = (payload: never) => void;

class FakeBridge implements DesktopBridge {
  files = new Map<string, Uint8Array>();
  calls: string[] = [];
  listeners = new Map<string, Set<Callback>>();
  recover: { id: string; startedAt: number; recordedMs: number; pausedMs: number; maxDurationMs: number } | null = null;
  failed: { id: string; segmentId: string; reason: string; error: string; journal: NonNullable<FakeBridge["recover"]> }[] = [];
  elapsed = 0;
  paused = 0;
  current: string | null = null;
  state: "idle" | "recording" | "paused" = "idle";
  selectedId: string | null = null;
  stopError: Error | null = null;
  now = 1_000_000;

  emit(event: string, payload: unknown) {
    for (const callback of this.listeners.get(event) ?? []) callback(payload as never);
  }
  status() {
    return { state: this.state, reason: this.state === "paused" ? "user" : null, id: this.current,
      startedAt: this.current ? this.now : null, elapsedMs: this.elapsed, audioMs: this.elapsed,
      pausedMs: this.paused, maxDurationMs: 10_000, intent: this.state === "idle" ? "stopped" : this.state,
      availability: "available", at: this.now, elapsedAt: this.now };
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
      case "delete_audio_file": this.files.delete(id);
        this.failed = this.failed.filter((item) => item.id !== id);
        result = null; break;
      default: throw new Error(`Unexpected command ${command}`);
    }
    return result as T;
  }
}

function rig(bridge = new FakeBridge(), dbName = crypto.randomUUID(), env: IdbEnv = newIdbEnv(),
  storeOptions: Partial<WebStoreOptions> = {}, id = "note-1") {
  return openDesktopVoiceNotes({ bridge, now: () => bridge.now, newId: () => id,
    storeOptions: { env, dbName, locks: memoryLocks(), decodeCheck: null, now: () => bridge.now, ...storeOptions } });
}

describe("desktop recorder adapter", () => {
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
