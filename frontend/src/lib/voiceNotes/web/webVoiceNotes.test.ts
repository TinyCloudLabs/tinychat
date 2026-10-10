import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { base64ToBytes } from "../voiceNoteAudio";
import { VOICE_NOTE_MAX_DURATION_MS, VOICE_NOTE_MIN_DURATION_LIMIT_MS, type VoiceNoteRecording } from "../nativeVoiceNotes";
import { FakeMediaRecorder, createRig, memoryAudioBlobs, slowTest, type Rig, type RigOptions } from "./webTestKit";
import { DecodeCheckError, memoryLocks, openWebStore, type DecodeCheck } from "./webStore";
import {
  UNSUPPORTED_METHODS, WEB_CAPABILITIES, WEB_MAX_DURATION_MS, WEB_MIN_DURATION_LIMIT_MS,
} from "./webVoiceNotes";

const test = slowTest(bunTest);

const code = (value: string) => expect.objectContaining({ code: value });
const HOUR = 60 * 60 * 1000;

afterEach(() => { FakeMediaRecorder.supported = new Set(["audio/webm;codecs=opus", "audio/mp4"]); });

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.error;
  const warn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  return fn().finally(() => { console.error = log; console.warn = warn; });
}

async function readAll(rig: Rig, id: string) {
  const parts: number[] = [];
  for (let offset = 0;;) {
    const chunk = await rig.engine.plugin.readAudioChunk({ id, offset, length: 1 << 20 });
    parts.push(...base64ToBytes(chunk.base64));
    offset += chunk.bytesRead;
    if (chunk.eof) return Uint8Array.from(parts);
  }
}

const VALID_MIC_STATES: Record<string, (string | null)[]> = {
  recording: [null, "no_signal", "os_silenced", "input_muted"],
  silenced: ["no_signal", "os_silenced", "input_muted"],
  paused: ["user"],
  needs_user: ["resume_blocked", "mic_unavailable", "stalled", "resume_not_allowed", "permission_revoked", "write_failed"],
  interrupted: ["call", "stalled", "interruption", "route_change", "media_services_reset", "read_error", "app_suspended"],
  idle: [null, "user", "max_duration", "disk_full", "write_failed", "permission_revoked"],
};

async function listen(rig: Rig) {
  const micStates: { state: string; reason: string | null }[] = [];
  const events: Record<string, unknown[]> = {};
  const plugin = rig.engine.plugin;
  await plugin.addListener("micState", (e) => micStates.push({ state: e.state, reason: e.reason }));
  for (const name of ["autoStopped", "committed", "recovered", "recoveryFailed", "writeFailure", "level", "inputs"] as const) {
    events[name] = [];
    await plugin.addListener(name as "committed", ((e: unknown) => events[name]!.push(e)) as never);
  }
  await rig.settle();
  return { micStates, events };
}

describe("capabilities and constants", () => {
  test("a browser has none of the seven capabilities", async () => {
    const rig = await createRig();
    expect(rig.engine.capabilities).toEqual({
      nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
      background: false, localTranscription: false, desktopWhisper: false, offlineRecorder: false,
    });
    expect(WEB_CAPABILITIES).toEqual(rig.engine.capabilities);
  });

  test("the duration bounds equal the native ones", () => {
    expect(WEB_MAX_DURATION_MS).toBe(VOICE_NOTE_MAX_DURATION_MS);
    expect(WEB_MIN_DURATION_LIMIT_MS).toBe(VOICE_NOTE_MIN_DURATION_LIMIT_MS);
  });

  test("every method with no web meaning rejects with an unsupported error", async () => {
    const { engine } = await createRig();
    expect([...UNSUPPORTED_METHODS]).toEqual(["dismissShortcutRecovery", "consumeShortcutRecord", "openSettings"]);
    const plugin = engine.plugin as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const method of UNSUPPORTED_METHODS) {
      await expect(plugin[method]!({ id: "x" })).rejects.toBeInstanceOf(Error);
      await expect(plugin[method]!({ id: "x" })).rejects.toEqual(code("unsupported"));
    }
  });
});

describe("recording", () => {
  test("a chunk counts toward audioMs only after its write is durable", async () => {
    let gate: Promise<void> | null = null;
    const rig = await createRig({ hooks: { beforeOp: async (op) => { if (op === "audio:append" && gate) await gate; } } });
    const { plugin } = rig.engine;
    await plugin.start();
    expect(await plugin.status()).toMatchObject({ state: "recording", audioMs: 0 });
    let open!: () => void;
    gate = new Promise<void>((resolve) => { open = resolve; });
    rig.fake.recorder().encode([1, 2, 3, 4]);
    rig.clock.advance(1000);
    rig.fake.recorder().deliver();
    await rig.settle();
    expect(await plugin.status()).toMatchObject({ audioMs: 0 });
    expect((await plugin.status()).elapsedMs).toBeLessThanOrEqual(1000);
    gate = null;
    open();
    await rig.settle();
    expect(await plugin.status()).toMatchObject({ audioMs: 1000 });
    const note = await plugin.stop();
    expect(note).toMatchObject({ durationMs: 1000, sizeBytes: 4 });
  });

  test("a chunk that never became durable is not in the note", async () => {
    let failNext = false;
    const rig = await createRig({ hooks: { beforeOp: (op) => { if (op === "audio:append" && failNext) throw new Error("disk"); } } });
    const { plugin } = rig.engine;
    await plugin.start();
    await rig.chunk([1, 2, 3]);
    failNext = true;
    await quiet(async () => { await rig.chunk([9, 9, 9, 9]); await rig.settle(); });
    expect(await plugin.listPending()).toMatchObject({ recordings: [{ sizeBytes: 3, durationMs: 1000 }] });
  });

  test("pause stops the mic, resume re-acquires the same device, and the stored bytes are one container's output", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const { micStates } = await listen(rig);
    await plugin.start();
    await plugin.selectInput({ id: "usb-1" });
    await rig.chunk([1, 2, 3]);
    await plugin.pause();
    expect(rig.fake.mic.liveTracks()).toEqual([]);
    expect(await plugin.status()).toMatchObject({ state: "paused", reason: "user", intent: "paused", audioMs: 1000 });
    rig.clock.advance(5000);
    expect((await plugin.status()).elapsedMs).toBe(1000);
    expect((await plugin.status()).pausedMs).toBe(5000);
    await plugin.resume();
    expect(rig.fake.mic.calls.at(-1)).toEqual({ audio: { deviceId: { exact: "usb-1" } } });
    expect(rig.fake.mic.liveTracks().map((t) => t.deviceId)).toEqual(["usb-1"]);
    await rig.chunk([4, 5]);
    const note = await plugin.stop();
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(note).toMatchObject({ durationMs: 2000, sizeBytes: 5, pausedMs: 5000, mimeType: "audio/webm;codecs=opus", rev: 1, owner: null });
    expect(Array.from(await readAll(rig, note.id))).toEqual([1, 2, 3, 4, 5]);
    expect(rig.fake.mic.liveTracks()).toEqual([]);
    expect(micStates.map((m) => m.state)).toEqual(["recording", "recording", "paused", "recording", "idle"]);
  });

  test("elapsedMs is the durable audio plus at most two timeslices of live time (native #193 behaviour)", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    await plugin.start();
    await rig.chunk([1]);
    rig.clock.advance(700);
    expect((await plugin.status()).elapsedMs).toBe(1700);
    rig.clock.advance(60_000);
    expect((await plugin.status()).elapsedMs).toBe(3000);
    expect((await plugin.status()).audioMs).toBe(1000);
  });

  test("the limit counts recorded time only, then auto-stops with a committed note", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const { events } = await listen(rig);
    const started = await plugin.start({ maxDurationMs: 3000 });
    expect(started.maxDurationMs).toBe(3000);
    await rig.chunk([1]);
    await plugin.pause();
    rig.clock.advance(5 * HOUR);
    await plugin.resume();
    await rig.chunk([2]);
    expect((await plugin.status()).state).toBe("recording");
    await rig.chunk([3]);
    await rig.settle();
    expect(await plugin.status()).toMatchObject({ state: "idle", intent: "stopped" });
    expect(events.autoStopped).toMatchObject([{ id: started.id, reason: "max_duration", maxDurationMs: 3000, error: null, recording: { id: started.id, durationMs: 3000 } }]);
    expect(events.committed).toMatchObject([{ id: started.id }]);
    expect((await plugin.listPending()).recordings).toHaveLength(1);
    expect(rig.fake.mic.liveTracks()).toEqual([]);
    await plugin.start();
    await plugin.discard();
  });

  test("the requested limit is clamped to [1 s, 3 h] and defaults to 3 h", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    expect((await plugin.start()).maxDurationMs).toBe(3 * HOUR);
    await plugin.discard();
    expect((await plugin.start({ maxDurationMs: 5 })).maxDurationMs).toBe(1000);
    await plugin.discard();
    expect((await plugin.start({ maxDurationMs: 99 * HOUR })).maxDurationMs).toBe(3 * HOUR);
  });

  test("a stop with no audio rejects with no_audio_captured and leaves nothing behind", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const { id } = await plugin.start();
    await expect(plugin.stop()).rejects.toEqual(code("no_audio_captured"));
    expect(await rig.store.getSession(id)).toBeNull();
    expect((await plugin.listPending()).recordings).toEqual([]);
    expect(await plugin.status()).toMatchObject({ state: "idle" });
    await plugin.start();
  });

  test("controls without a recording reject not_recording; a second start rejects already_recording", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    await expect(plugin.stop()).rejects.toEqual(code("not_recording"));
    await expect(plugin.pause()).rejects.toEqual(code("not_recording"));
    await expect(plugin.resume()).rejects.toEqual(code("not_recording"));
    expect(await plugin.discard()).toEqual({ id: null });
    await plugin.start();
    await expect(plugin.start()).rejects.toEqual(code("already_recording"));
  });

  test("a second tab cannot record while this one does, and can once it stops", async () => {
    const rig = await createRig();
    const other = await createRig({ idb: rig.idb, clock: rig.clock, locks: rig.locks });
    await rig.engine.plugin.start();
    await expect(other.engine.plugin.start()).rejects.toEqual(code("already_recording"));
    await rig.chunk([1]);
    await rig.engine.plugin.stop();
    await other.engine.plugin.start();
  });

  test("discard throws the recording away: tombstone, audio gone, mic released", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const { id } = await plugin.start();
    await rig.chunk([1, 2]);
    expect(await plugin.discard()).toEqual({ id });
    expect(await rig.store.audio.size(id)).toBe(0);
    expect(rig.fake.mic.liveTracks()).toEqual([]);
    expect((await plugin.listPending()).recordings).toEqual([]);
    expect(await plugin.status()).toMatchObject({ state: "idle", id: null });
  });

  test("setRecordingOptions applies to the live note; signed-out notes stay on-device", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    await plugin.start({ transcriber: "assemblyai" });
    expect((await plugin.status()).options).toEqual({ transcriber: "on-device", identifySpeakers: false });
    await plugin.setRecordingOptions({ identifySpeakers: true, transcriber: "assemblyai" });
    expect((await plugin.status()).options).toEqual({ transcriber: "on-device", identifySpeakers: true });
    await rig.chunk([1]);
    expect(await plugin.stop()).toMatchObject({ options: { transcriber: "on-device", identifySpeakers: true } });
  });

  test("signing in during a recording claims it", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    await plugin.start();
    await rig.chunk([1]);
    const { claimed } = await plugin.setCaptureDefaults({ accountDid: "did:A", transitionGen: 1, transcriber: "assemblyai", identifySpeakers: false });
    expect(claimed).toHaveLength(1);
    expect((await plugin.status()).owner).toBe("did:A");
    expect(await plugin.stop()).toMatchObject({ owner: "did:A" });
  });

  test("the retained committed event reaches a listener that attaches late", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const a = await plugin.start(); await rig.chunk([1]); await plugin.stop();
    const b = await plugin.start(); await rig.chunk([1]); await plugin.stop();
    const received: string[] = [];
    await plugin.addListener("committed", (e) => received.push(e.id));
    await rig.settle();
    expect(received).toEqual([a.id, b.id]);
  });
});

describe("start failures", () => {
  test("a denied permission rejects permission_denied and leaves no session or lock behind", async () => {
    const rig = await createRig();
    rig.fake.mic.denied = true;
    await expect(rig.engine.plugin.start()).rejects.toEqual(code("permission_denied"));
    expect(await rig.store.getSession("00000000-0000-4000-8000-000000000001")).toBeNull();
    rig.fake.mic.denied = false;
    await rig.engine.plugin.start();
  });

  test("a missing selected microphone falls back to the default only when the selection is gone from the device list", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    await plugin.selectInput({ id: "usb-1" });
    rig.fake.mic.devices = rig.fake.mic.devices.filter((d) => d.deviceId !== "usb-1");
    expect((await plugin.start()).id).toBeTruthy();
    expect((await plugin.status()).input?.id).toBe("default");
    expect((await plugin.listInputs()).selectedId).toBeNull();
    await plugin.discard();
    rig.fake.mic.devices.push({ deviceId: "usb-1", label: "USB Microphone" });
    await plugin.selectInput({ id: "usb-1" });
    rig.fake.mic.missing.add("usb-1");
    await expect(plugin.start()).rejects.toEqual(code("mic_unavailable"));
  });

  test("a browser with no supported recording format fails visibly before touching the microphone", async () => {
    const rig = await createRig();
    FakeMediaRecorder.supported = new Set();
    await expect(rig.engine.plugin.start()).rejects.toEqual(code("unsupported_format"));
    await expect(rig.engine.plugin.start()).rejects.toThrow(/cannot record audio in a format/);
    expect(rig.fake.mic.calls).toEqual([]);
  });
});

describe("failures while recording", () => {
  test("a failed chunk write stops the recording and commits what is durable", async () => {
    let fail = false;
    const rig = await createRig({ hooks: { beforeOp: (op) => { if (op === "audio:append" && fail) throw new Error("write failed"); } } });
    const { plugin } = rig.engine;
    const { events, micStates } = await listen(rig);
    const { id } = await plugin.start();
    await rig.chunk([1, 2, 3]);
    fail = true;
    await quiet(() => rig.chunk([4, 5, 6]));
    await rig.settle();
    expect(events.writeFailure).toEqual([{ id, error: "write failed" }]);
    expect(events.autoStopped).toMatchObject([{ id, reason: "write_failed", recording: { sizeBytes: 3, durationMs: 1000 }, error: null }]);
    expect(await plugin.status()).toMatchObject({ state: "idle" });
    expect(micStates.at(-1)).toEqual({ state: "idle", reason: null });
    expect(rig.fake.mic.liveTracks()).toEqual([]);
  });

  test("a full disk is reported as disk_full; with nothing durable the note is dropped", async () => {
    const rig = await createRig({ hooks: { beforeOp: (op) => { if (op === "audio:append") throw new DOMException("full", "QuotaExceededError"); } } });
    const { events } = await listen(rig);
    await rig.engine.plugin.start();
    await quiet(() => rig.chunk([1, 2, 3]));
    await rig.settle();
    expect(events.autoStopped).toMatchObject([{ reason: "disk_full", recording: null, error: "no_audio_captured" }]);
    expect((await rig.engine.plugin.listPending()).recordings).toEqual([]);
  });

  describe("a journal write that fails (full disk) after the audio write", () => {
    const quotaAt = (nth: number) => {
      let seen = 0;
      return { beforeOp: (op: string) => { if (op === "session:progress" && ++seen === nth) throw new DOMException("full", "QuotaExceededError"); } };
    };

    test("atomic store, first slice: nothing was written, so the note is dropped as disk_full", async () => {
      const rig = await createRig({ hooks: quotaAt(1) });
      const { events } = await listen(rig);
      await rig.engine.plugin.start();
      await quiet(() => rig.chunk([1, 2, 3]));
      await rig.settle();
      expect(events.autoStopped).toMatchObject([{ reason: "disk_full", recording: null, error: "no_audio_captured" }]);
      expect((await rig.engine.plugin.listPending()).recordings).toEqual([]);
    });

    test("atomic store, later slice: the rolled-back slice is lost, every earlier slice is committed", async () => {
      const rig = await createRig({ hooks: quotaAt(2) });
      const { events } = await listen(rig);
      await rig.engine.plugin.start();
      await rig.chunk([1, 2, 3]);
      await quiet(() => rig.chunk([4, 5, 6]));
      await rig.settle();
      expect(events.autoStopped).toMatchObject([{ reason: "disk_full", recording: { sizeBytes: 3, durationMs: 1000 } }]);
      const id = (events.autoStopped[0] as { id: string }).id;
      expect(Array.from(await readAll(rig, id))).toEqual([1, 2, 3]);
    });

    for (const [name, nth, sizeBytes] of [["first", 1, 3], ["later", 2, 6]] as const) {
      test(`non-atomic blob store, ${name} slice: the written bytes are never deleted and are in the committed note`, async () => {
        const blobs = memoryAudioBlobs();
        const rig = await createRig({ audio: blobs.create, hooks: quotaAt(nth) });
        const { events } = await listen(rig);
        await rig.engine.plugin.start();
        if (nth === 2) await rig.chunk([1, 2, 3]);
        await quiet(() => rig.chunk(nth === 2 ? [4, 5, 6] : [1, 2, 3]));
        await rig.settle();
        expect(events.autoStopped).toMatchObject([{ reason: "disk_full", recording: { sizeBytes, durationMs: nth * 1000 } }]);
        expect(events.writeFailure).toMatchObject([{ error: expect.stringContaining("full") }]);
        const id = (events.autoStopped[0] as { id: string }).id;
        expect(blobs.sizeOf(id)).toBe(sizeBytes);
        expect(Array.from(await readAll(rig, id))).toEqual(sizeBytes === 3 ? [1, 2, 3] : [1, 2, 3, 4, 5, 6]);
      });
    }
  });

  test("a claim by another tab while recording survives the stop", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    await plugin.start();
    await rig.chunk([1, 2, 3]);
    const other = await openWebStore({ env: rig.idb, locks: memoryLocks(), now: rig.clock.now });
    const { claimed } = await other.setCaptureDefaults({ accountDid: "did:A", transitionGen: 1, transcriber: "assemblyai", identifySpeakers: false });
    expect(claimed).toHaveLength(1);
    const note = await plugin.stop();
    expect(note.owner).toBe("did:A");
    expect((await plugin.listPending()).recordings.map((r) => r.owner)).toEqual(["did:A"]);
  });

  describe("pause releases the microphone without waiting for the encoder", () => {
    test("a dataavailable that arrives late: the tracks are released at once and the late slice still counts", async () => {
      const rig = await createRig();
      const { plugin } = rig.engine;
      await plugin.start();
      await rig.chunk([1, 2, 3]);
      rig.fake.env.flushTimeoutMs = 60_000;
      rig.fake.recorder().requestDataMode = "deferred";
      rig.fake.recorder().encode([4, 5]);
      const paused = plugin.pause();
      await rig.settle();
      expect(rig.fake.mic.liveTracks()).toEqual([]);
      rig.fake.recorder().releaseRequestedData();
      await paused;
      expect(await plugin.status()).toMatchObject({ state: "paused", reason: "user" });
      await rig.settle();
      const note = await plugin.stop();
      expect(note.sizeBytes).toBe(5);
    });

    test("a dataavailable that never arrives: pause completes after the flush timeout, still paused/user, and nothing is reported as failed", async () => {
      const rig = await createRig();
      const { plugin } = rig.engine;
      const { micStates, events } = await listen(rig);
      await plugin.start();
      await rig.chunk([1, 2, 3]);
      rig.fake.recorder().requestDataMode = "never";
      micStates.length = 0;
      await quiet(() => plugin.pause());
      expect(rig.fake.mic.liveTracks()).toEqual([]);
      expect(await plugin.status()).toMatchObject({ state: "paused", reason: "user", intent: "paused" });
      expect(micStates.every((s) => s.state === "paused" && s.reason === "user")).toBe(true);
      expect(events.writeFailure).toEqual([]);
    });

    test("a slice delivered after the timeout keeps its pre-pause duration; the state is paused/user throughout and nothing is reported as failed", async () => {
      const rig = await createRig();
      const { plugin } = rig.engine;
      const { micStates, events } = await listen(rig);
      await plugin.start();
      await rig.chunk([1, 2, 3]);
      expect(await plugin.status()).toMatchObject({ audioMs: 1000 });
      rig.fake.recorder().requestDataMode = "deferred";
      rig.fake.recorder().encode([4, 5]);
      rig.clock.advance(1000);
      micStates.length = 0;
      await quiet(() => plugin.pause());
      expect(rig.fake.mic.liveTracks()).toEqual([]);
      expect(await plugin.status()).toMatchObject({ state: "paused", reason: "user", intent: "paused", audioMs: 1000 });

      rig.clock.advance(30_000);
      rig.fake.recorder().releaseRequestedData();
      await rig.settle();
      expect(await plugin.status()).toMatchObject({ state: "paused", reason: "user", audioMs: 2000 });
      expect(micStates.every((s) => s.state === "paused" && s.reason === "user")).toBe(true);
      expect(events.writeFailure).toEqual([]);
      const note = await plugin.stop();
      expect(note).toMatchObject({ sizeBytes: 5, durationMs: 2000 });
      expect(events.writeFailure).toEqual([]);
    });

    test("resuming while the tail is pending is fine: the late slice still carries its pre-pause duration", async () => {
      const rig = await createRig();
      const { plugin } = rig.engine;
      const { events } = await listen(rig);
      await plugin.start();
      await rig.chunk([1]);
      const recorder = rig.fake.recorder();
      recorder.requestDataMode = "deferred";
      recorder.encode([2]);
      rig.clock.advance(1000);
      await quiet(() => plugin.pause());
      await plugin.resume();
      expect(await plugin.status()).toMatchObject({ state: "recording", reason: null });
      recorder.releaseRequestedData();
      await rig.settle();
      expect(await plugin.status()).toMatchObject({ audioMs: 2000 });
      const note = await plugin.stop();
      expect(note).toMatchObject({ sizeBytes: 2, durationMs: 2000 });
      expect(events.writeFailure).toEqual([]);
    });

    test("stop waits for a pending tail slice that arrives within the bound, then commits it with the right duration and no failure", async () => {
      const rig = await createRig();
      const { plugin } = rig.engine;
      const { micStates, events } = await listen(rig);
      await plugin.start();
      await rig.chunk([1, 2, 3]);
      rig.fake.env.stopTailTimeoutMs = 60_000;
      rig.fake.recorder().requestDataMode = "deferred";
      rig.fake.recorder().encode([4, 5]);
      rig.clock.advance(1000);
      await quiet(() => plugin.pause());
      let stopped = false;
      const stopping = plugin.stop().then((recording) => { stopped = true; return recording; });
      await rig.settle();
      expect(stopped).toBe(false);
      rig.fake.recorder().releaseRequestedData();
      const note = await stopping;
      expect(note).toMatchObject({ sizeBytes: 5, durationMs: 2000 });
      expect(events.writeFailure).toEqual([]);
      expect(events.committed).toHaveLength(1);
      expect(micStates.some((s) => s.state === "needs_user")).toBe(false);
    });

    test("stop with a tail slice that never arrives commits the durable part and reports write_failed", async () => {
      const rig = await createRig();
      const { plugin } = rig.engine;
      const { events } = await listen(rig);
      const { id } = await plugin.start();
      await rig.chunk([1, 2, 3]);
      rig.fake.env.stopTailTimeoutMs = 50;
      rig.fake.recorder().requestDataMode = "never";
      rig.fake.recorder().encode([4, 5]);
      rig.clock.advance(1000);
      await quiet(() => plugin.pause());
      expect(events.writeFailure).toEqual([]);
      const note = await quiet(() => plugin.stop());
      expect(note).toMatchObject({ id, sizeBytes: 3, durationMs: 1000 });
      expect(events.committed).toHaveLength(1);
      expect(events.writeFailure).toEqual([{ id, error: "pause_flush_timeout" }]);
      expect(await plugin.status()).toMatchObject({ state: "idle" });
    });

    test("a late slice from an earlier pause does not satisfy the wait of a later pause", async () => {
      const rig = await createRig();
      const { plugin } = rig.engine;
      await plugin.start();
      await rig.chunk([1]);
      const recorder = rig.fake.recorder();
      recorder.requestDataMode = "deferred";
      recorder.encode([2]);
      rig.clock.advance(1000);
      await quiet(() => plugin.pause());
      await plugin.resume();
      recorder.requestDataMode = "immediate";
      recorder.encode([3]);
      rig.clock.advance(1000);
      // The first pause's slice finally arrives while the second pause is waiting for its own.
      rig.fake.env.flushTimeoutMs = 60_000;
      recorder.requestDataMode = "deferred";
      const paused = plugin.pause();
      await rig.settle();
      recorder.releaseRequestedData();
      await rig.settle();
      let settled = false;
      void paused.then(() => { settled = true; });
      await rig.settle();
      expect(settled).toBe(false);
      recorder.releaseRequestedData();
      await paused;
      expect(settled).toBe(true);
    });
  });

  test("losing the microphone blocks the recording; plugging it back in and resuming continues it with a typed gap", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    await plugin.start();
    await rig.chunk([1]);
    rig.fake.mic.tracks()[0]!.endByOs();
    await rig.settle();
    expect(await plugin.status()).toMatchObject({ state: "needs_user", reason: "mic_unavailable", availability: "blocked", openSpan: { kind: "omitted", reason: "mic_unavailable" } });
    rig.clock.advance(4000);
    await plugin.resume();
    expect(await plugin.status()).toMatchObject({ state: "recording", reason: null, openSpan: null });
    await rig.chunk([2]);
    const note = await plugin.stop();
    expect(note.spans).toMatchObject([{ kind: "omitted", reason: "mic_unavailable", endedAt: expect.any(Number) }]);
  });

  test("a revoked permission is reported as permission_revoked", async () => {
    const rig = await createRig();
    await rig.engine.plugin.start();
    rig.fake.mic.permissionState = "denied";
    rig.fake.mic.tracks()[0]!.endByOs();
    await rig.settle();
    expect(await rig.engine.plugin.status()).toMatchObject({ state: "needs_user", reason: "permission_revoked" });
  });

  test("a resume the browser refuses reports a blocked cell and rejects, then a later resume works", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    await plugin.start();
    await rig.chunk([1]);
    await plugin.pause();
    rig.fake.mic.denied = true;
    await expect(plugin.resume()).rejects.toEqual(code("resume_not_allowed"));
    expect(await plugin.status()).toMatchObject({ state: "needs_user", reason: "resume_not_allowed", availability: "blocked" });
    expect(rig.fake.mic.liveTracks()).toEqual([]);
    rig.fake.mic.denied = false;
    await plugin.resume();
    expect(await plugin.status()).toMatchObject({ state: "recording", reason: null });
  });

  test("an OS mute opens a silenced span that the note keeps", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    await plugin.start();
    await rig.chunk([1]);
    const track = rig.fake.mic.tracks()[0]!;
    track.onmute?.();
    await rig.settle();
    expect(await plugin.status()).toMatchObject({ state: "silenced", reason: "input_muted", openSpan: { kind: "silenced" } });
    rig.clock.advance(1000);
    await rig.chunk([2]);
    track.onunmute?.();
    await rig.settle();
    expect((await plugin.status()).state).toBe("recording");
    const note = await plugin.stop();
    expect(note).toMatchObject({ silencedEvents: 1, spans: [{ kind: "silenced", reason: "input_muted" }] });
  });

  test("every micState the engine emits is a valid state/reason cell of the contract", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const { micStates } = await listen(rig);
    await plugin.start();
    await rig.chunk([1]);
    await plugin.pause();
    rig.fake.mic.denied = true;
    await plugin.resume().catch(() => {});
    rig.fake.mic.denied = false;
    await plugin.resume();
    rig.fake.mic.tracks().at(-1)!.endByOs();
    await rig.settle();
    await plugin.resume();
    rig.fake.mic.tracks().at(-1)!.onmute?.();
    await rig.settle();
    await plugin.discard();
    expect(micStates.length).toBeGreaterThan(6);
    for (const { state, reason } of micStates) expect(VALID_MIC_STATES[state], `${state}/${reason}`).toContain(reason);
  });
});

describe("inputs and levels", () => {
  test("labels exist only after permission, and listInputs says so", async () => {
    const rig = await createRig();
    rig.fake.mic.devices = [{ deviceId: "", label: "" }, { deviceId: "abc", label: "" }];
    const before = await rig.engine.plugin.listInputs();
    expect(before).toMatchObject({ labelsAvailable: false, selectedId: null, activeId: null });
    expect(before.inputs.map((i) => i.name)).toEqual(["Microphone 1", "Microphone 2"]);
    rig.fake.mic.devices = [{ deviceId: "default", label: "Default - Built-in Microphone" }, { deviceId: "usb-1", label: "USB Microphone" }];
    const after = await rig.engine.plugin.listInputs();
    expect(after).toMatchObject({ labelsAvailable: true });
    expect(after.inputs).toEqual([{ id: "default", name: "Default - Built-in Microphone", kind: "built_in" }, { id: "usb-1", name: "USB Microphone", kind: "usb" }]);
  });

  test("selectInput swaps the track mid-recording, rejects unknown inputs and applies while paused on resume", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const { events } = await listen(rig);
    await expect(plugin.selectInput({ id: "nope" })).rejects.toEqual(code("input_not_found"));
    await plugin.start();
    await plugin.selectInput({ id: "usb-1" });
    expect(rig.fake.mic.liveTracks().map((t) => t.deviceId)).toEqual(["usb-1"]);
    expect(await plugin.listInputs()).toMatchObject({ selectedId: "usb-1", activeId: "usb-1" });
    expect((await plugin.status()).input?.id).toBe("usb-1");
    expect(events.inputs.length).toBeGreaterThan(0);
    await rig.chunk([1]);
    await plugin.pause();
    await plugin.selectInput({ id: "default" });
    expect(rig.fake.mic.liveTracks()).toEqual([]);
    await plugin.resume();
    expect(rig.fake.mic.liveTracks().map((t) => t.deviceId)).toEqual(["default"]);
    await plugin.selectInput({ id: null });
    expect((await plugin.listInputs()).selectedId).toBeNull();
  });

  test("a device change is published as an inputs event", async () => {
    const rig = await createRig();
    const { events } = await listen(rig);
    rig.fake.deviceChange();
    await rig.settle();
    expect(events.inputs).toMatchObject([{ labelsAvailable: true, inputs: [{ id: "default" }, { id: "usb-1" }] }]);
  });

  test("level events carry level/peak on the 30 Hz timer while recording and stop when paused", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const { events } = await listen(rig);
    await plugin.start();
    rig.fake.context().analyser.samples.fill(0.25);
    rig.clock.advance(33);
    rig.fake.timers.tick();
    expect(events.level).toHaveLength(1);
    expect(events.level[0]).toMatchObject({ active: true });
    expect((events.level[0] as { level: number }).level).toBeGreaterThan(0.1);
    await plugin.pause();
    const count = events.level.length;
    rig.fake.timers.tick();
    expect(events.level).toHaveLength(count);
    await plugin.discard();
  });
});

describe("pending notes: playback and deletion", () => {
  test("localAudioUrl serves the stored bytes and deleteAudio revokes it", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const { id } = await plugin.start();
    await rig.chunk([7, 8, 9]);
    await plugin.stop();
    const { url } = await plugin.localAudioUrl({ id });
    expect(url.startsWith("blob:")).toBe(true);
    expect((await plugin.localAudioUrl({ id })).url).toBe(url);
    const blob = await (await fetch(url)).blob();
    expect(blob.type).toBe("audio/webm;codecs=opus");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([7, 8, 9]);
    await plugin.deleteAudio({ id });
    await expect(plugin.localAudioUrl({ id })).rejects.toEqual(code("tombstoned"));
  });

  test("the live recording cannot be deleted, retried or discarded as a failed recording", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const { id } = await plugin.start();
    await expect(plugin.deleteAudio({ id })).rejects.toEqual(code("recording_in_progress"));
    await expect(plugin.retryRecovery({ id })).rejects.toEqual(code("recording_in_progress"));
    await expect(plugin.discardFailedRecording({ id })).rejects.toEqual(code("recording_in_progress"));
    await expect(plugin.deleteQuarantined({ id })).rejects.toEqual(code("recording_in_progress"));
  });
});

describe("recovery after the tab died", () => {
  test("recoverInterrupted turns a dead tab's chunks into a recovered recording and announces it once", async () => {
    const rig = await createRig();
    const { id } = await rig.engine.plugin.start();
    await rig.chunk([1, 2, 3]);
    await rig.chunk([4, 5]);
    const next: Rig = await rig.reopen();
    const { events } = await listen(next);
    const result = await next.engine.recoverInterrupted();
    expect(result.recovered).toMatchObject([{ id, recovered: true, endedUnexpectedly: true, sizeBytes: 5, durationMs: 2000 }]);
    await next.settle();
    expect(events.recovered).toMatchObject([{ id, recording: { id } }]);
    expect(Array.from(await readAll(next, id))).toEqual([1, 2, 3, 4, 5]);
    expect((await next.engine.recoverInterrupted()).recovered).toEqual([]);
    expect(events.recovered).toHaveLength(1);
  });

  test("retryRecovery re-arms a quarantined recording and recovers it", async () => {
    let failing = true;
    const options: RigOptions = { hooks: { beforeOp: (op) => { if (failing && op === "note:commit") throw new Error("no"); } } };
    const rig = await createRig();
    const { id } = await rig.engine.plugin.start();
    await rig.chunk([1, 2]);
    const next = await rig.reopen(options);
    await quiet(async () => { for (let i = 0; i < 3; i++) await next.engine.recoverInterrupted(); });
    expect((await next.engine.plugin.listQuarantine()).items).toMatchObject([{ id }]);
    failing = false;
    await next.engine.plugin.retryRecovery({ id });
    expect((await next.engine.plugin.listQuarantine()).items).toEqual([]);
    expect((await next.engine.plugin.listPending()).recordings.map((r) => r.id)).toEqual([id]);
  });

  test("a decoder that cannot run announces recoveryFailed, keeps the session, and retryRecovery recovers it later", async () => {
    let usable = false;
    const decodeCheck: DecodeCheck = async () => {
      if (!usable) throw new DecodeCheckError("resource", "NotSupportedError: no decoder");
      return { durationMs: 1000 };
    };
    const rig = await createRig();
    const { id } = await rig.engine.plugin.start();
    await rig.chunk([1, 2]);
    const next = await rig.reopen({ decodeCheck });
    const { events } = await listen(next);
    const result = await quiet(() => next.engine.recoverInterrupted());
    await next.settle();
    expect(result.failed).toMatchObject([{ id, reason: "decoder_unavailable" }]);
    expect(events.recoveryFailed).toMatchObject([{ id, reason: "decoder_unavailable" }]);
    expect((await next.engine.plugin.listQuarantine()).items).toEqual([]);
    usable = true;
    await next.engine.plugin.retryRecovery({ id });
    expect((await next.engine.plugin.listPending()).recordings.map((r) => r.id)).toEqual([id]);
  });

  test("dispose releases the microphone and keeps recorded audio on disk for recovery", async () => {
    const rig = await createRig();
    const { id } = await rig.engine.plugin.start();
    await rig.chunk([1, 2]);
    rig.engine.dispose();
    expect(rig.fake.mic.liveTracks()).toEqual([]);
    const next = await rig.reopen();
    expect((await next.engine.recoverInterrupted()).recovered.map((r: VoiceNoteRecording) => r.id)).toEqual([id]);
  });
});
