// A saved receipt whose phone copy cannot be opened says so calmly; the detail stays in the console.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { __setOnDeviceSttForTests } from "@/lib/voiceNotes/onDeviceStt";
import { __setVoiceNotesForTests, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { installDom } from "@/test/dom";
import { voiceNoteRoute } from "./RouteLine";
import { SavedReceipt } from "./SavedReceipt";

let cleanupDom: (() => void) | undefined;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  cleanupDom?.();
  cleanupDom = undefined;
  __setVoiceNotesForTests(undefined as unknown as VoiceNotesPlugin, { available: null });
});

describe("SavedReceipt phone audio", () => {
  test("a phone copy that cannot be opened shows calm copy and logs the cause", async () => {
    const cause = new Error("loadVoiceNoteAudio: Key not found: xyz.tinycloud.tinychat/connectors/exo-voice-note/audio/rec-1");
    __setVoiceNotesForTests({ localAudioUrl: async () => { throw cause; } } as unknown as VoiceNotesPlugin, { available: true });
    __setOnDeviceSttForTests(createFakeOnDeviceStt().plugin);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      cleanupDom = installDom();
      const host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => root!.render(
        <SavedReceipt outcome="saved" saved={{ id: "rec-1", durationMs: 42_000, at: Date.UTC(2026, 9, 9, 9, 41) }} route={voiceNoteRoute("off")} onDone={() => {}} onSaveNow={() => {}} />,
      ));
      const alert = host.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe("Couldn’t open this note’s audio on this phone.");
      expect(host.textContent).not.toContain("Key not found");
      expect(host.textContent).not.toContain("loadVoiceNoteAudio");
      expect(logged).toHaveBeenCalledWith("[Receipt] Could not open this phone's audio", cause);
    } finally {
      logged.mockRestore();
    }
  });
});
