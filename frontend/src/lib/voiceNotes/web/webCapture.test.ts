import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { createWebCapture, pickRecorderMimeType, TIMESLICE_MS, UNSUPPORTED_FORMAT_MESSAGE, type CaptureCallbacks, type InputLoss } from "./webCapture";
import { FakeClock, FakeMediaRecorder, createFakeEnv, slowTest } from "./webTestKit";
import type { LevelSample } from "./webLevels";

const test = slowTest(bunTest);

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

function setup() {
  const clock = new FakeClock();
  const fake = createFakeEnv(clock);
  const chunks: { size: number; durationMs: number }[] = [];
  const levels: LevelSample[] = [];
  const losses: InputLoss[] = [];
  const muted: boolean[] = [];
  const errors: unknown[] = [];
  const callbacks: CaptureCallbacks = {
    onChunk: ({ blob, durationMs }) => chunks.push({ size: blob.size, durationMs }),
    onLevel: (sample) => levels.push(sample),
    onInputLost: (loss) => losses.push(loss),
    onMute: (value) => muted.push(value),
    onRecorderError: (error) => errors.push(error),
  };
  const capture = createWebCapture(fake.env, callbacks);
  return { clock, fake, capture, chunks, levels, losses, muted, errors };
}

afterEach(() => { FakeMediaRecorder.supported = new Set(["audio/webm;codecs=opus", "audio/mp4"]); });

describe("recorder format", () => {
  test("prefers webm/opus, falls back to mp4, and otherwise refuses with a visible error", () => {
    expect(pickRecorderMimeType(FakeMediaRecorder)).toBe("audio/webm;codecs=opus");
    FakeMediaRecorder.supported = new Set(["audio/mp4"]);
    expect(pickRecorderMimeType(FakeMediaRecorder)).toBe("audio/mp4");
    expect(setup().capture.mimeType).toBe("audio/mp4");
    FakeMediaRecorder.supported = new Set();
    expect(pickRecorderMimeType(FakeMediaRecorder)).toBeNull();
    expect(() => setup()).toThrow(UNSUPPORTED_FORMAT_MESSAGE);
    try { setup(); } catch (error) { expect((error as { code?: string }).code).toBe("unsupported_format"); }
  });

  test("the recorder is created with the chosen type and a one-second timeslice", async () => {
    const { capture, fake } = setup();
    await capture.start(null);
    expect(TIMESLICE_MS).toBe(1000);
    expect(fake.recorder()).toMatchObject({ mimeType: "audio/webm;codecs=opus", timeslice: 1000, state: "recording" });
  });
});

describe("start, chunks and stop", () => {
  test("start prompts once, reports the input and delivers chunks timed from the clock", async () => {
    const { capture, fake, clock, chunks } = setup();
    const input = await capture.start(null);
    expect(fake.mic.calls).toEqual([{ audio: true }]);
    expect(input).toEqual({ id: "default", name: "Default - Built-in Microphone", kind: "built_in" });
    fake.recorder().encode([1, 2, 3]);
    clock.advance(1000);
    fake.recorder().deliver();
    fake.recorder().encode([4, 5]);
    clock.advance(1010);
    fake.recorder().deliver();
    expect(chunks).toEqual([{ size: 3, durationMs: 1000 }, { size: 2, durationMs: 1010 }]);
  });

  test("a chosen device is requested exactly", async () => {
    const { capture, fake } = setup();
    expect((await capture.start("usb-1")).id).toBe("usb-1");
    expect(fake.mic.calls).toEqual([{ audio: { deviceId: { exact: "usb-1" } } }]);
  });

  test("a denied prompt rejects and leaves nothing open", async () => {
    const { capture, fake } = setup();
    fake.mic.denied = true;
    await expect(capture.start(null)).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(fake.mic.liveTracks()).toEqual([]);
    expect(fake.context().state).toBe("closed");
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  test("stop delivers the last slice, waits for the recorder to finish and releases the mic and the graph", async () => {
    const { capture, fake, chunks, clock } = setup();
    await capture.start(null);
    fake.recorder().encode([1, 2, 3, 4]);
    clock.advance(400);
    await capture.stop();
    expect(chunks).toEqual([{ size: 4, durationMs: 400 }]);
    expect(fake.recorder().state).toBe("inactive");
    expect(fake.mic.liveTracks()).toEqual([]);
    expect(fake.context().state).toBe("closed");
    expect(fake.timers.count()).toBe(0);
  });

  test("abort delivers nothing and releases everything", async () => {
    const { capture, fake, chunks } = setup();
    await capture.start(null);
    fake.recorder().encode([1, 2, 3]);
    capture.abort();
    expect(chunks).toEqual([]);
    expect(fake.mic.liveTracks()).toEqual([]);
    expect(fake.timers.count()).toBe(0);
  });
});

describe("pause and resume", () => {
  test("pause flushes the open slice, pauses the recorder and stops the mic tracks", async () => {
    const { capture, fake, chunks, clock, levels } = setup();
    await capture.start(null);
    fake.recorder().encode([1, 2, 3]);
    clock.advance(600);
    await capture.pause();
    expect(chunks).toEqual([{ size: 3, durationMs: 600 }]);
    expect(fake.recorder().state).toBe("paused");
    expect(fake.mic.liveTracks()).toEqual([]);
    expect(fake.timers.count()).toBe(0);
    expect(levels.at(-1)).toEqual({ level: 0, peak: 0, active: false });
    expect(capture.activeInput).toBeNull();
  });

  test("resume re-acquires the same device and keeps writing into the very same recorder", async () => {
    const { capture, fake, chunks, clock } = setup();
    await capture.start("usb-1");
    fake.recorder().encode([1, 1]);
    clock.advance(1000);
    await capture.pause();
    clock.advance(30_000);
    expect(fake.mic.liveTracks()).toEqual([]);
    const input = await capture.resume();
    expect(input.id).toBe("usb-1");
    expect(fake.mic.calls.at(-1)).toEqual({ audio: { deviceId: { exact: "usb-1" } } });
    expect(fake.mic.liveTracks()).toHaveLength(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(fake.recorder().state).toBe("recording");
    fake.recorder().encode([2, 2, 2]);
    clock.advance(1000);
    fake.recorder().deliver();
    expect(chunks).toEqual([{ size: 2, durationMs: 1000 }, { size: 3, durationMs: 1000 }]);
    expect(fake.timers.count()).toBe(1);
  });

  test("resume can move to another device and a resume that cannot open the mic rejects with the browser error", async () => {
    const { capture, fake } = setup();
    await capture.start("usb-1");
    await capture.pause();
    expect((await capture.resume("default")).id).toBe("default");
    await capture.pause();
    fake.mic.missing.add("usb-1");
    await expect(capture.resume("usb-1")).rejects.toMatchObject({ name: "OverconstrainedError" });
    expect(fake.recorder().state).toBe("paused");
    expect(fake.mic.liveTracks()).toEqual([]);
  });

  test("resume with nothing started is refused", async () => {
    await expect(setup().capture.resume()).rejects.toMatchObject({ code: "not_recording" });
  });
});

describe("switching input mid-recording", () => {
  test("the new device takes over and the old track is released without restarting the recorder", async () => {
    const { capture, fake } = setup();
    await capture.start(null);
    const input = await capture.switchInput("usb-1");
    expect(input.id).toBe("usb-1");
    expect(fake.mic.liveTracks().map((t) => t.deviceId)).toEqual(["usb-1"]);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(fake.recorder().state).toBe("recording");
    expect(capture.activeInput?.id).toBe("usb-1");
  });

  test("a device that cannot be opened leaves the current one recording", async () => {
    const { capture, fake } = setup();
    await capture.start(null);
    fake.mic.missing.add("usb-1");
    await expect(capture.switchInput("usb-1")).rejects.toMatchObject({ name: "OverconstrainedError" });
    expect(fake.mic.liveTracks().map((t) => t.deviceId)).toEqual(["default"]);
    expect(capture.activeInput?.id).toBe("default");
  });
});

describe("losing the microphone", () => {
  test("a track that ends while permission is denied is reported as permission_revoked, with capture held", async () => {
    const { capture, fake, losses } = setup();
    await capture.start(null);
    fake.mic.permissionState = "denied";
    fake.mic.tracks()[0]!.endByOs();
    await settle();
    expect(losses).toEqual([{ reason: "permission_revoked" }]);
    expect(fake.recorder().state).toBe("paused");
    expect(fake.mic.liveTracks()).toEqual([]);
  });

  test("a track that ends with permission intact is mic_unavailable", async () => {
    const { capture, fake, losses } = setup();
    await capture.start(null);
    fake.mic.tracks()[0]!.endByOs();
    await settle();
    expect(losses).toEqual([{ reason: "mic_unavailable" }]);
  });

  test("OS mute and unmute are forwarded for the current track only", async () => {
    const { capture, fake, muted } = setup();
    await capture.start(null);
    const [track] = fake.mic.tracks();
    track!.onmute?.();
    track!.onunmute?.();
    expect(muted).toEqual([true, false]);
    await capture.switchInput("usb-1");
    expect(track!.onmute).toBeNull();
  });
});
