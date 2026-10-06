// A signed-in space with captures in it, for the Library screens (TC-761): the
// empty-space stub (stubs.ts) with `connector_meeting` rows, their metadata and
// their transcripts answered the way the SDK answers them. Dates sit around the
// harness's frozen clock (2026-10-06 09:41).
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { audioBaseKey } from "@/lib/audio/audioStore";
import { transcriptKvKey } from "@/lib/connectors/connectorStore";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { harnessTcw } from "../stubs";

interface FixtureRow {
  id: string;
  source: string;
  sourceId: string;
  title: string;
  startedAt: string;
  durationSecs: number | null;
  metadata: Record<string, unknown>;
  sentences: FirefliesSentence[];
}

const at = (month: number, day: number, hour: number, minute: number) => new Date(2026, month - 1, day, hour, minute).toISOString();
const said = (speaker: string, ...texts: string[]): FirefliesSentence[] =>
  texts.map((text, index) => ({ index, speaker_name: speaker, text, start_time: index * 8, end_time: index * 8 + 7 }));
const stored = (source: string, id: string) => ({ audio: { stored: true, base: audioBaseKey(source, id) } });

export const LIBRARY_ROWS: FixtureRow[] = [
  {
    id: "note-transcribed",
    source: "exo-voice-note",
    sourceId: "rec-0928",
    title: "Voice note · Oct 6, 9:28 AM",
    startedAt: at(10, 6, 9, 28),
    durationSecs: 42,
    metadata: {
      ...stored("exo-voice-note", "rec-0928"),
      capture: { platform: "ios", duration_ms: 42_000 },
      transcription_engine: "private-cloud",
      transcript_provider: "tinycloud-private-transcription",
      inference_provider: "tinfoil",
      transcription_outcome: "transcribed",
      transcript_text: "Book the venue for the offsite before Friday.",
    },
    sentences: said(
      "You",
      "Book the venue for the offsite before Friday, and ask Ana whether the second room is still free.",
      "Then send the agenda to everyone on the planning thread.",
    ),
  },
  {
    id: "note-untranscribed",
    source: "exo-voice-note",
    sourceId: "rec-0802",
    title: "Voice note · Oct 6, 8:02 AM",
    startedAt: at(10, 6, 8, 2),
    durationSecs: 192,
    metadata: { ...stored("exo-voice-note", "rec-0802"), capture: { platform: "ios", duration_ms: 192_000 } },
    sentences: [],
  },
  {
    id: "meeting-weekly",
    source: "tinycloud-transcriber",
    sourceId: "mtg_weekly",
    title: "Weekly sync",
    startedAt: at(10, 5, 14, 0),
    durationSecs: 1880,
    metadata: { platform: "google_meet", meeting_url: "https://meet.google.com/abc-defg-hij", transcript_provider: "assemblyai" },
    sentences: [
      ...said("Ana", "We agreed to ship the beta on the twentieth, with the Library and the note detail in it."),
      ...said("Ben", "Then the iOS build goes to TestFlight on Thursday so we have a few days of real use."),
      ...said("Ana", "Good. I'll write the release notes tonight."),
    ],
  },
  {
    id: "fireflies-design",
    source: "fireflies",
    sourceId: "ff-design",
    title: "Design review",
    startedAt: at(10, 5, 10, 0),
    durationSecs: 2765,
    metadata: {},
    sentences: said("Mira", "The list pane keeps its scroll when you open a note."),
  },
  {
    id: "upload-interview",
    source: "exo-upload",
    sourceId: "upload-interview",
    title: "Customer interview",
    startedAt: at(10, 3, 16, 30),
    durationSecs: 3130,
    metadata: {
      ...stored("exo-upload", "upload-interview"),
      capture: "upload",
      transcription_engine: "assemblyai",
      transcript_provider: "assemblyai",
      inference_provider: "assemblyai",
      assemblyai_account: "own",
    },
    sentences: [
      ...said("Speaker A", "What made you try it in the first place?"),
      ...said("Speaker B", "I wanted my notes somewhere I own, not in another app's cloud."),
    ],
  },
  {
    id: "upload-board",
    source: "exo-upload",
    sourceId: "upload-board",
    title: "Board call",
    startedAt: at(9, 30, 11, 0),
    durationSecs: 2400,
    metadata: {
      audio: { stored: false, reason: "quota" },
      capture: "upload",
      transcription_engine: "private-cloud",
      transcript_provider: "tinycloud-private-transcription",
      inference_provider: "tinfoil",
    },
    sentences: said("Speaker A", "Revenue is up eleven percent on the quarter."),
  },
  {
    id: "gmeet-standup",
    source: "google-meet",
    sourceId: "conf-standup",
    title: "Standup",
    startedAt: at(9, 29, 9, 0),
    durationSecs: 900,
    metadata: {},
    sentences: said("Lee", "Nothing blocking today."),
  },
];

/**
 * The harness space with `rows` stored. `hang` leaves the list read pending
 * (the Library's loading state).
 */
export function libraryTcw(options: { rows?: readonly FixtureRow[]; hang?: boolean } = {}): TinyCloudWeb {
  const rows = options.rows ?? LIBRARY_ROWS;
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes("WHERE source IN")) {
      if (options.hang) return new Promise(() => {});
      return { ok: true, data: { rows: rows.map((r) => [r.id, r.source, r.sourceId, r.title, r.startedAt, r.durationSecs]) } };
    }
    if (sql.includes("SELECT metadata FROM connector_meeting WHERE id = ?")) {
      const row = rows.find((r) => r.id === params[0]);
      return { ok: true, data: { rows: row ? [[JSON.stringify(row.metadata)]] : [] } };
    }
    return { ok: true, data: { rows: [] } };
  };
  const get = async (key: string) => {
    const row = rows.find((r) => transcriptKvKey(r.source, r.sourceId) === key);
    return row ? { ok: true, data: { data: row.sentences, headers: {} } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "harness: nothing stored" } };
  };
  const sql = { db: () => ({ query }) };
  const kv = new Proxy({ get } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : (harnessTcw.kv as unknown as Record<string | symbol, unknown>)[key]),
  });
  return new Proxy(harnessTcw, {
    get: (target, key) => (key === "sql" ? sql : key === "kv" ? kv : key === "spaceId" ? "harness-library" : Reflect.get(target, key)),
  }) as TinyCloudWeb;
}
