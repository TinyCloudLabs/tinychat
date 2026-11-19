import { describe, expect, test } from "bun:test";
import { transcriptionModelLabel } from "./transcriptionModelLabel";
import { LOCAL_WHISPER_MODELS } from "@/lib/localTranscriber";

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

  test("names the cloud speech models by their provider's product name", () => {
    expect(transcriptionModelLabel("whisper-large-v3-turbo")).toBe("Whisper Large v3 Turbo (Tinfoil)");
    expect(transcriptionModelLabel("universal-3-5-pro")).toBe("AssemblyAI Universal-3.5 Pro");
    expect(transcriptionModelLabel("universal-2")).toBe("AssemblyAI Universal-2");
  });

  test("shows an unmapped id that is a short plain token as it is", () => {
    expect(transcriptionModelLabel("some-future-model")).toBe("some-future-model");
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

  test("names each local model with the desktop's native display name, the one its recorder caption shows", () => {
    const native: Record<string, string> = {
      QuantizedTinyEn: "Whisper Tiny (English)",
      QuantizedTiny: "Whisper Tiny (Multilingual)",
      QuantizedBaseEn: "Whisper Base (English)",
      QuantizedBase: "Whisper Base (Multilingual)",
      QuantizedSmallEn: "Whisper Small (English)",
      QuantizedSmall: "Whisper Small (Multilingual)",
      QuantizedLargeTurbo: "Whisper Large Turbo (Multilingual)",
    };
    for (const model of LOCAL_WHISPER_MODELS) {
      expect(transcriptionModelLabel(model.id)).toBe(native[model.id]);
    }
  });

  // Picker wording that differs from the saved label today. The picker is not changed by this PR; when the picker
  // is fixed, its label matches the saved label and this test fails, so the entry must be removed.
  const PICKER_WORDING_DRIFT: Record<string, string> = {
    QuantizedTiny: "Whisper Tiny (multilingual)",
    QuantizedBase: "Whisper Base (multilingual)",
    QuantizedSmall: "Whisper Small (multilingual)",
    QuantizedLargeTurbo: "Whisper Large Turbo",
  };

  test("each local model's picker label equals its saved label, except the known wording drift", () => {
    for (const model of LOCAL_WHISPER_MODELS) {
      expect(model.label).toBe(PICKER_WORDING_DRIFT[model.id] ?? transcriptionModelLabel(model.id));
    }
  });
});
