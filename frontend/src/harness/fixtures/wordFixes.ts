// A note whose transcript says "tiny cloud" and "eliza" the way a transcriber hears them, for the word fixes screens (TC-2199).
import type { LIBRARY_ROWS } from "./library";

const at = (month: number, day: number, hour: number, minute: number) => new Date(2026, month - 1, day, hour, minute).toISOString();

export const WORD_FIX_ROWS: typeof LIBRARY_ROWS = [
  {
    id: "note-word-fixes",
    source: "exo-upload",
    sourceId: "upload-word-fixes",
    title: "Product call",
    startedAt: at(10, 6, 10, 15),
    durationSecs: 2160,
    metadata: { capture: "upload", transcription_engine: "private-cloud", transcript_provider: "tinycloud-private-transcription", inference_provider: "tinfoil" },
    sentences: [
      { index: 0, speaker_name: "Me", text: "Thanks for joining. Tiny cloud keeps the notes in your own space, so Eliza can read them too.", start_time: 0, end_time: 9 },
      { index: 1, speaker_name: "Them", text: "Nice. Does tiny   cloud sync across devices, or only on this phone?", start_time: 10, end_time: 19 },
      { index: 2, speaker_name: "Me", text: "Across devices. Ask eliza to open the TINY CLOUD settings.", start_time: 20, end_time: 27 },
    ],
  },
];
