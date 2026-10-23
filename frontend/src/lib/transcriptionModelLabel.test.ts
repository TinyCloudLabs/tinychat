import { describe, expect, test } from "bun:test";
import { transcriptionModelLabel } from "./transcriptionModelLabel";

describe("transcriptionModelLabel", () => {
  test("names each Whisper model the desktop records, with the casing the desktop shows", () => {
    expect(transcriptionModelLabel("QuantizedTinyEn")).toBe("Whisper Tiny (English)");
    expect(transcriptionModelLabel("QuantizedTiny")).toBe("Whisper Tiny (Multilingual)");
    expect(transcriptionModelLabel("QuantizedBaseEn")).toBe("Whisper Base (English)");
    expect(transcriptionModelLabel("QuantizedBase")).toBe("Whisper Base (Multilingual)");
    expect(transcriptionModelLabel("QuantizedSmallEn")).toBe("Whisper Small (English)");
    expect(transcriptionModelLabel("QuantizedSmall")).toBe("Whisper Small (Multilingual)");
    expect(transcriptionModelLabel("QuantizedLargeTurbo")).toBe("Whisper Large Turbo (Multilingual)");
  });

  test("names the Parakeet and Apple models, with and without the int8 suffix", () => {
    expect(transcriptionModelLabel("parakeet-tdt-0.6b-v3")).toBe("Parakeet TDT 0.6B v3");
    expect(transcriptionModelLabel("parakeet-tdt-0.6b-v3-int8")).toBe("Parakeet TDT 0.6B v3");
    expect(transcriptionModelLabel("parakeet-tdt-110m-en")).toBe("Parakeet TDT 110M (English)");
    expect(transcriptionModelLabel("parakeet-tdt-110m-en-int8")).toBe("Parakeet TDT 110M (English)");
    expect(transcriptionModelLabel("speech-transcriber")).toBe("Apple SpeechTranscriber");
    expect(transcriptionModelLabel("dictation-transcriber")).toBe("Apple Dictation");
  });

  test("shows an unmapped id that is a short plain token as it is", () => {
    expect(transcriptionModelLabel("whisper-large-v3-turbo")).toBe("whisper-large-v3-turbo");
  });

  test("shows nothing for a missing, empty, non-string, or markup-like id", () => {
    expect(transcriptionModelLabel(undefined)).toBeNull();
    expect(transcriptionModelLabel(null)).toBeNull();
    expect(transcriptionModelLabel("")).toBeNull();
    expect(transcriptionModelLabel(42)).toBeNull();
    expect(transcriptionModelLabel("<script>alert(1)</script>")).toBeNull();
    expect(transcriptionModelLabel("a".repeat(41))).toBeNull();
  });

  test("does not return an inherited property for an id that only looks like one", () => {
    expect(transcriptionModelLabel("constructor")).toBe("constructor");
    expect(transcriptionModelLabel("__proto__")).toBe("__proto__");
  });
});
