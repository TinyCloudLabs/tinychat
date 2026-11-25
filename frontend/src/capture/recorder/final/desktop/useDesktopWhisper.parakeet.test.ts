import { expect, test } from "bun:test";
import { localDesktopCaption, localDesktopExplanation } from "./useDesktopWhisper";

// The Local stop's copy names the selected model. Parakeet's label names its engine; Whisper's copy is unchanged.

test("Parakeet selected: the copy names Parakeet, not Whisper", () => {
  expect(localDesktopCaption("Parakeet TDT 0.6B v3")).toBe("Parakeet TDT 0.6B v3 on this Mac, after you stop.");
  expect(localDesktopExplanation("Parakeet TDT 0.6B v3")).toBe(
    "Parakeet TDT 0.6B v3 transcribes on this Mac after you stop, and nothing leaves the machine. Change the model in ⚙︎ Settings.");
});

test("Whisper selected: the copy is as before", () => {
  expect(localDesktopCaption("Whisper Small (English)")).toBe("Whisper Small (English) on this Mac, after you stop.");
  expect(localDesktopExplanation("Whisper Small (English)")).toBe(
    "Whisper Small (English) transcribes on this Mac after you stop, and nothing leaves the machine. Change the model in ⚙︎ Settings.");
});
