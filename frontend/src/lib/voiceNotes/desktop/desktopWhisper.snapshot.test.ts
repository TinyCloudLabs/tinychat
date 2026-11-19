import { expect, test } from "bun:test";
import type { VoiceNoteRecording } from "../nativeVoiceNotes";
import type { WebStore } from "../web/webStore";
import type { DesktopBridge } from "./desktopVoiceNotes";
import { createDesktopWhisperQueue, type DesktopWhisperBridge } from "./desktopWhisper";

test("the real Whisper snapshot keeps each job identity until the queue changes", async () => {
  const queue = createDesktopWhisperQueue({
    store: { updateStt: async () => {} } as unknown as WebStore,
    files: {} as DesktopBridge,
    whisper: {} as DesktopWhisperBridge,
    // Keep the queued work parked; no native mic, model, or transcription is needed.
    captureLive: () => true,
  });
  const note = (id: string) => ({ id, options: { transcriber: "on-device" } }) as VoiceNoteRecording;
  try {
    await queue.noteCommitted(note("first"));
    const firstSnapshot = queue.snapshot();
    const first = firstSnapshot.get("first");
    expect(first).toMatchObject({ state: "queued", position: 1, inLine: 1 });
    expect(queue.snapshot()).toBe(firstSnapshot);
    expect(queue.snapshot().get("first")).toBe(first);

    await queue.noteCommitted(note("second"));
    const changed = queue.snapshot();
    expect(changed).not.toBe(firstSnapshot);
    expect(changed.get("first")).toMatchObject({ position: 1, inLine: 2 });
    expect(changed.get("second")).toMatchObject({ position: 2, inLine: 2 });
    expect(queue.snapshot()).toBe(changed);
    expect(queue.snapshot().get("second")).toBe(changed.get("second"));
  } finally {
    queue.dispose();
  }
});
