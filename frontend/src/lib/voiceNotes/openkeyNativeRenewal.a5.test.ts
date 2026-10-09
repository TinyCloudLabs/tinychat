import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { VoiceNoteRecording } from "./nativeVoiceNotes";
import { currentAccountGeneration } from "./accountContext";

test("the real voice-note save runs after the a4 renewal fixture", async () => {
  // Import after a4's afterAll: Bun retains its first mock.module factory.
  const { saveVoiceNote } = await import("./voiceNoteStore");
  const note: VoiceNoteRecording = {
    id: "after-a4", startedAt: 1, durationMs: 1000, mimeType: "audio/mp4",
    sizeBytes: 1, silencedMs: 0, silencedEvents: 0, noSignalMs: 0,
  };
  const source = { mimeType: "audio/mp4", size: 1, readPart: async () => new Uint8Array([1]) };
  const result = await saveVoiceNote({} as TinyCloudWeb, note, source, "android", {
    checkpoint: () => { throw new Error("real save checkpoint"); },
  });
  expect(result).toEqual({ ok: false, error: { code: "STORE_ERROR", message: "real save checkpoint" } });

  // recorderSaves was imported while a4's module mock was active. Its next
  // account save must also reach the real saveVoiceNote after that file ends.
  const { saveNoteForAccount } = await import("./recorderSaves");
  const did = "did:example:after-a4";
  let checks = 0;
  const outcome = await saveNoteForAccount({ did, spaceId: "space", kv: {
    list: () => { throw new Error("stale a4 fixture was invoked"); },
  } } as unknown as TinyCloudWeb,
    { did, spaceId: "space", generation: currentAccountGeneration() },
    { ...note, version: 2, owner: did },
    () => { if (++checks === 2) throw new Error("real pipeline save checkpoint"); });
  expect(outcome).toEqual({ kind: "failed", failure: "real pipeline save checkpoint" });
});
