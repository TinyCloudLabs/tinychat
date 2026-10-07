import { expect, test } from "bun:test";
import { createFakeOnDeviceStt } from "./fakeOnDeviceStt";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";

test("on-device STT fake reports model readiness, queue progress, completion and cancellation", async () => {
  const { plugin, controls } = createFakeOnDeviceStt();
  const progress: number[] = [];
  await plugin.addListener("progress", ({ percent }) => { progress.push(percent); });
  await plugin.enqueue({ id: "note-1" });
  expect((await plugin.status()).queue[0].state).toBe("waiting_for_model");
  await plugin.downloadNow({ allowCellular: false });
  expect((await plugin.status()).download).toEqual({ policy: "wifi", state: "running" });
  controls.setModel("parakeet-tdt-0.6b-v3-int8", "ready", 100, 100);
  expect((await plugin.status()).queue[0].state).toBe("queued");
  controls.progress("note-1", 50);
  controls.finish("note-1", "transcribed");
  expect(progress).toEqual([50]);
  expect((await plugin.status()).queue[0].state).toBe("done");
  await plugin.enqueue({ id: "note-2" });
  await plugin.cancel({ id: "note-2" });
  expect((await plugin.status()).queue[1].state).toBe("cancelled");
  await plugin.deleteModels();
  expect((await plugin.status()).engine).toBe("none");
});

test("on-device STT refuses work after the note is tombstoned", async () => {
  const voice = createFakeVoiceNotes();
  const { id } = await voice.plugin.start();
  await voice.plugin.stop();
  const stt = createFakeOnDeviceStt("full", voice.controls.tombstoned);
  await stt.plugin.enqueue({ id });
  await voice.plugin.deleteAudio({ id });
  await expect(stt.plugin.enqueue({ id })).rejects.toMatchObject({ code: "tombstoned" });
  expect(() => stt.controls.finish(id, "transcribed")).toThrow("tombstoned");
});
