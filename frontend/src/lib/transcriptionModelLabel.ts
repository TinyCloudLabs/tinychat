/** Human label for the transcription model a transcript records (`model` on the transcript). */
const LABELS: Record<string, string> = {
  QuantizedTinyEn: "Whisper Tiny (English)",
  QuantizedTiny: "Whisper Tiny (Multilingual)",
  QuantizedBaseEn: "Whisper Base (English)",
  QuantizedBase: "Whisper Base (Multilingual)",
  QuantizedSmallEn: "Whisper Small (English)",
  QuantizedSmall: "Whisper Small (Multilingual)",
  QuantizedLargeTurbo: "Whisper Large Turbo (Multilingual)",
  "parakeet-tdt-0.6b-v3": "Parakeet TDT 0.6B v3",
  "parakeet-tdt-0.6b-v3-int8": "Parakeet TDT 0.6B v3",
  "parakeet-tdt-110m-en": "Parakeet TDT 110M (English)",
  "parakeet-tdt-110m-en-int8": "Parakeet TDT 110M (English)",
  "speech-transcriber": "Apple SpeechTranscriber",
  "dictation-transcriber": "Apple Dictation",
};

/** Ids we do not map are shown only when they are short plain tokens; anything else is not displayed. */
const PLAIN_ID = /^[A-Za-z0-9 ._-]{1,40}$/;

/** The label for a transcript's recorded model id, or null when there is none to show. */
export function transcriptionModelLabel(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (Object.hasOwn(LABELS, raw)) return LABELS[raw] ?? null;
  return PLAIN_ID.test(raw) ? raw : null;
}
