import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { VOICE_NOTE_SAFETY_CAP_MS } from "../nativeVoiceNotes";
import { FakeMediaRecorder, createRig, slowTest } from "./webTestKit";
import { WEB_MAX_DURATION_MS, WEB_SAFETY_CAP_MS } from "./webVoiceNotes";

const test = slowTest(bunTest);

const code = (value: string) => expect.objectContaining({ code: value });
const HOUR = 60 * 60 * 1000;

afterEach(() => { FakeMediaRecorder.supported = new Set(["audio/webm;codecs=opus", "audio/mp4"]); });

describe("web engine: the eight-hour safety cap and setMaxDuration", () => {
  test("the safety cap is the shared 8 h constant and the default stays 3 h", () => {
    expect(WEB_SAFETY_CAP_MS).toBe(VOICE_NOTE_SAFETY_CAP_MS);
    expect(WEB_SAFETY_CAP_MS).toBe(8 * HOUR);
    expect(WEB_MAX_DURATION_MS).toBe(3 * HOUR);
  });

  test("start keeps an 8 h request, clamps 9 h to 8 h, and defaults to 3 h", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    expect((await plugin.start({ maxDurationMs: 8 * HOUR })).maxDurationMs).toBe(8 * HOUR);
    expect(await plugin.status()).toMatchObject({ maxDurationMs: 8 * HOUR });
    await plugin.discard();
    expect((await plugin.start({ maxDurationMs: 9 * HOUR })).maxDurationMs).toBe(8 * HOUR);
    await plugin.discard();
    expect((await plugin.start()).maxDurationMs).toBe(3 * HOUR);
    await plugin.discard();
    expect(await plugin.status()).toMatchObject({ state: "idle", maxDurationMs: 3 * HOUR });
  });

  test("setMaxDuration while idle rejects no_recording", async () => {
    const rig = await createRig();
    await expect(rig.engine.plugin.setMaxDuration!({ maxDurationMs: 4 * HOUR })).rejects.toEqual(code("no_recording"));
  });

  test("setMaxDuration clamps to [1 s, 8 h], resolves with the limit in force, and journals it", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const { id } = await plugin.start();
    expect(await plugin.setMaxDuration!({ maxDurationMs: 4 * HOUR })).toEqual({ maxDurationMs: 4 * HOUR });
    expect(await plugin.status()).toMatchObject({ maxDurationMs: 4 * HOUR });
    expect((await rig.store.getSession(id))?.maxDurationMs).toBe(4 * HOUR);
    expect(await plugin.setMaxDuration!({ maxDurationMs: 99 * HOUR })).toEqual({ maxDurationMs: 8 * HOUR });
    expect((await rig.store.getSession(id))?.maxDurationMs).toBe(8 * HOUR);
    expect(await plugin.setMaxDuration!({ maxDurationMs: 5 })).toEqual({ maxDurationMs: 1000 });
    expect((await rig.store.getSession(id))?.maxDurationMs).toBe(1000);
    await plugin.discard();
    await expect(plugin.setMaxDuration!({ maxDurationMs: HOUR })).rejects.toEqual(code("no_recording"));
  });

  test("a raised limit keeps the recording past the old limit and stops at the new one", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const stops: unknown[] = [];
    await plugin.addListener("autoStopped", (event) => stops.push(event));
    const { id } = await plugin.start({ maxDurationMs: 3000 });
    await rig.chunk([1]);
    await rig.chunk([2]);
    await plugin.setMaxDuration!({ maxDurationMs: 5000 });
    await rig.chunk([3]);
    await rig.chunk([4]);
    expect(await plugin.status()).toMatchObject({ state: "recording", audioMs: 4000, maxDurationMs: 5000 });
    expect(stops).toEqual([]);
    await rig.chunk([5]);
    expect(await plugin.status()).toMatchObject({ state: "idle" });
    expect(stops).toMatchObject([{ id, reason: "max_duration", maxDurationMs: 5000, error: null, recording: { id, durationMs: 5000 } }]);
  });

  test("a limit raised after the old limit was reached but before the stop ran cancels that stop", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const stops: unknown[] = [];
    await plugin.addListener("autoStopped", (event) => stops.push(event));
    await plugin.start({ maxDurationMs: 2000 });
    await rig.chunk([1]);
    // The second slice reaches the old limit; the raise lands before the scheduled stop runs.
    rig.fake.recorder().encode([2]);
    rig.clock.advance(1000);
    rig.fake.recorder().deliver();
    await plugin.setMaxDuration!({ maxDurationMs: 6000 });
    await rig.settle();
    expect(await plugin.status()).toMatchObject({ state: "recording", audioMs: 2000, maxDurationMs: 6000 });
    expect(stops).toEqual([]);
    await plugin.discard();
  });

  test("a limit at or below the recorded time stops the recording like any other limit", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const stops: unknown[] = [];
    await plugin.addListener("autoStopped", (event) => stops.push(event));
    const { id } = await plugin.start();
    await rig.chunk([1]);
    await rig.chunk([2]);
    await plugin.setMaxDuration!({ maxDurationMs: 1000 });
    await rig.settle();
    expect(await plugin.status()).toMatchObject({ state: "idle" });
    expect(stops).toMatchObject([{ id, reason: "max_duration", maxDurationMs: 1000, recording: { id, durationMs: 2000 } }]);
  });

  test("the raised limit survives a tab death and is used by recovery", async () => {
    const rig = await createRig();
    const { plugin } = rig.engine;
    const { id } = await plugin.start({ maxDurationMs: 3000 });
    await rig.chunk([1]);
    await plugin.setMaxDuration!({ maxDurationMs: 7000 });
    const next = await rig.reopen();
    expect((await next.store.getSession(id))?.maxDurationMs).toBe(7000);
    await next.engine.recoverInterrupted();
    expect((await next.engine.plugin.listPending()).recordings.map((r) => r.id)).toEqual([id]);
  });
});
