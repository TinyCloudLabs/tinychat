import { describe, expect, test } from "bun:test";
import { createFakeVoiceNotes as createHarnessFake } from "@/harness/fakeVoiceNotes";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";

const code = (value: string) => expect.objectContaining({ code: value });
const HOUR = 60 * 60 * 1000;

describe("VoiceNotes fake: the eight-hour safety cap and setMaxDuration", () => {
  test("start keeps 8 h, clamps 9 h to 8 h and defaults to 3 h", async () => {
    const { plugin } = createFakeVoiceNotes();
    expect((await plugin.start({ maxDurationMs: 8 * HOUR })).maxDurationMs).toBe(8 * HOUR);
    await plugin.discard();
    expect((await plugin.start({ maxDurationMs: 9 * HOUR })).maxDurationMs).toBe(8 * HOUR);
    await plugin.discard();
    expect((await plugin.start()).maxDurationMs).toBe(3 * HOUR);
    await plugin.discard();
    expect(await plugin.status()).toMatchObject({ state: "idle", maxDurationMs: 3 * HOUR });
  });

  test("setMaxDuration rejects no_recording when idle and clamps while recording", async () => {
    const { plugin } = createFakeVoiceNotes();
    await expect(plugin.setMaxDuration!({ maxDurationMs: HOUR })).rejects.toEqual(code("no_recording"));
    await plugin.start();
    expect(await plugin.setMaxDuration!({ maxDurationMs: 99 * HOUR })).toEqual({ maxDurationMs: 8 * HOUR });
    expect(await plugin.setMaxDuration!({ maxDurationMs: 5 })).toEqual({ maxDurationMs: 1000 });
    expect(await plugin.status()).toMatchObject({ maxDurationMs: 1000 });
  });

  test("a raised limit does not stop at the old limit but stops at the new one", async () => {
    let clock = 0;
    const { plugin, controls } = createFakeVoiceNotes(() => clock);
    await plugin.start({ maxDurationMs: 10_000 });
    clock = 9000; controls.tick(9000);
    await plugin.setMaxDuration!({ maxDurationMs: 20_000 });
    clock = 12_000; controls.tick(3000);
    expect((await plugin.status()).state).toBe("recording");
    clock = 20_000; controls.tick(8000);
    expect((await plugin.status()).state).toBe("idle");
    expect((await plugin.listPending()).recordings[0]).toMatchObject({ durationMs: 20_000 });
  });
});

describe("harness VoiceNotes fake: the eight-hour safety cap and setMaxDuration", () => {
  test("start keeps 8 h, clamps 9 h to 8 h and defaults to 3 h", async () => {
    const fake = createHarnessFake();
    expect((await fake.plugin.start({ maxDurationMs: 8 * HOUR })).maxDurationMs).toBe(8 * HOUR);
    await fake.plugin.discard();
    expect((await fake.plugin.start({ maxDurationMs: 9 * HOUR })).maxDurationMs).toBe(8 * HOUR);
    await fake.plugin.discard();
    expect((await fake.plugin.start()).maxDurationMs).toBe(3 * HOUR);
  });

  test("setMaxDuration changes the running limit, is recorded in stats and rejects no_recording when idle", async () => {
    const fake = createHarnessFake();
    await expect(fake.plugin.setMaxDuration!({ maxDurationMs: HOUR })).rejects.toEqual(code("no_recording"));
    expect(fake.stats().maxDurationChanges).toEqual([]);
    await fake.plugin.start();
    expect(await fake.plugin.setMaxDuration!({ maxDurationMs: 4 * HOUR })).toEqual({ maxDurationMs: 4 * HOUR });
    expect(await fake.plugin.setMaxDuration!({ maxDurationMs: 99 * HOUR })).toEqual({ maxDurationMs: 8 * HOUR });
    expect(await fake.plugin.status()).toMatchObject({ maxDurationMs: 8 * HOUR });
    expect(fake.stats().maxDurationChanges).toEqual([4 * HOUR, 8 * HOUR]);
  });
});
