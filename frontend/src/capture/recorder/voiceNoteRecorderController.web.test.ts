// The real recorder controller over the web engine: a slice the engine proves lost keeps its
// write_failed capture issue after the committed/autoStopped events that resolve issues by design.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { createRig, type Rig } from "@/lib/voiceNotes/web/webTestKit";
import { createVoiceNoteRecorderController } from "./voiceNoteRecorderController";

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { console.error = error; console.warn = warn; }
};

let rig: Rig;
let failAppend = false;

beforeEach(async () => {
  failAppend = false;
  rig = await createRig({ hooks: { beforeOp: (op) => { if (op === "audio:append" && failAppend) throw new Error("write failed"); } } });
  __setVoiceNotesForTests(rig.engine.plugin, { available: true });
});
afterEach(() => { __setVoiceNotesForTests(rig.engine.plugin, { available: null }); });

async function startRecording() {
  const recorder = createVoiceNoteRecorderController({
    tcw: null, available: true,
    transcriber: { noteSaved: () => {}, snapshot: () => ({ availability: "available", consented: false, capabilities: null, jobs: new Map() }) },
    onDeviceReady: () => true, appleInterim: () => false,
  });
  const detach = recorder.attach();
  await rig.settle();
  await recorder.record();
  await rig.settle();
  const id = recorder.getState().recordingId!;
  expect(id).toBeTruthy();
  return { recorder, detach, id };
}

describe("a lost slice keeps its capture issue through the controller", () => {
  test("a failed append after earlier durable audio", async () => {
    const { recorder, detach, id } = await startRecording();
    await rig.chunk([1, 2, 3]);
    failAppend = true;
    await quietly(async () => { await rig.chunk([4, 5, 6]); await rig.settle(); });
    expect(await rig.store.audio.size(id)).toBe(3);
    expect(recorder.getState().captureIssues[id]).toEqual({ kind: "write_failed", detail: "write failed" });
    detach();
  });

  test("an auto-stop whose pause tail never arrives", async () => {
    const { recorder, detach, id } = await startRecording();
    await rig.chunk([1, 2, 3]);
    rig.fake.env.stopTailTimeoutMs = 50;
    const media = rig.fake.recorder();
    media.requestDataMode = "never";
    media.encode([4, 5]);
    rig.clock.advance(1000);
    await quietly(async () => {
      await rig.engine.plugin.pause();
      media.onerror?.(new Error("encoder died"));
      await rig.settle();
    });
    expect(await rig.store.audio.size(id)).toBe(3);
    expect(recorder.getState().captureIssues[id]).toEqual({ kind: "write_failed", detail: "pause_flush_timeout" });
    detach();
  });

  test("a user stop whose tail arrives in time leaves no issue", async () => {
    const { recorder, detach, id } = await startRecording();
    await rig.chunk([1, 2, 3]);
    rig.fake.env.stopTailTimeoutMs = 60_000;
    const media = rig.fake.recorder();
    media.requestDataMode = "deferred";
    media.encode([4, 5]);
    rig.clock.advance(1000);
    await quietly(async () => {
      await rig.engine.plugin.pause();
      const stopping = recorder.stop();
      await rig.settle();
      media.releaseRequestedData();
      await stopping;
      await rig.settle();
    });
    expect(await rig.store.audio.size(id)).toBe(5);
    expect(recorder.getState().captureIssues[id]).toBeUndefined();
    detach();
  });
});
