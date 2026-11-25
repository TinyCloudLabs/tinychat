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
  /** The hash of the note's committed transcript (`voice_note_transcript`); without it the note has no commit. */
  commitHash?: string;
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

/** A two-sided note (Me / Them, as a Mac recording of both sides carries it) and the Library rows, for the speaker-name screens (TC-2189). */
export const SPEAKER_ROWS: FixtureRow[] = [
  ...LIBRARY_ROWS,
  {
    id: "note-me-them",
    source: "exo-upload",
    sourceId: "upload-offsite",
    title: "Offsite planning call",
    startedAt: at(10, 6, 10, 15),
    durationSecs: 2160,
    metadata: {
      ...stored("exo-upload", "upload-offsite"),
      capture: "upload",
      transcription_engine: "private-cloud",
      transcript_provider: "tinycloud-private-transcription",
      inference_provider: "tinfoil",
    },
    sentences: [
      { index: 0, speaker_name: "Me", text: "Thanks for making time. I wanted to walk through the offsite plan.", start_time: 0, end_time: 9 },
      { index: 1, speaker_name: "Them", text: "Happy to. The venue is booked and the agenda goes out Friday.", start_time: 10, end_time: 19 },
      { index: 2, speaker_name: "Me", text: "Good, then we only need the catering quote.", start_time: 20, end_time: 27 },
      { index: 3, speaker_name: "Them", text: "I'll chase it tomorrow morning.", start_time: 28, end_time: 33 },
    ],
  },
];

/** A Mac recording of both sides of a call, with the people the desktop app read from the call window (names in the call). */
const callRecording = (id: string, title: string, people: { id: string; name: string; self?: true }[], extra: Record<string, unknown> = {}): FixtureRow => ({
  id,
  source: "exo-voice-note",
  sourceId: `rec-${id}`,
  title,
  startedAt: at(10, 6, 9, 0),
  durationSecs: 1500,
  metadata: {
    ...stored("exo-voice-note", `rec-${id}`),
    capture: { platform: "tauri", duration_ms: 1_500_000, channels: 2 },
    transcription_engine: "private-cloud",
    transcript_provider: "tinycloud-private-transcription",
    inference_provider: "tinfoil",
    transcription_outcome: "transcribed",
    transcript_text: "Thanks for joining. The press kit is ready.",
    call_participants: { v: 1, source: "call_window", app: "google-meet", people, truncated: false },
    ...extra,
  },
  sentences: [
    { index: 0, speaker_name: "Me", text: "Thanks for joining. Let's go through the launch checklist.", start_time: 0, end_time: 6 },
    { index: 1, speaker_name: "Them", text: "Sounds good. The press kit is ready and the pricing page is nearly done.", start_time: 7, end_time: 14 },
    { index: 2, speaker_name: "Me", text: "Great. Then we only need the date for the announcement.", start_time: 15, end_time: 21 },
    { index: 3, speaker_name: "Them", text: "I'll send it over this afternoon.", start_time: 22, end_time: 25 },
  ],
});

/** The speaker-name rows and two call recordings: a group call (names offered as choices) and a 1:1 call. */
export const CALL_NAME_ROWS: FixtureRow[] = [
  ...SPEAKER_ROWS,
  callRecording("call-group", "Launch checklist", [
    { id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }]),
  // One other person in the call: their name was suggested for Them, and shows as suggested until kept or changed.
  callRecording("call-one", "Pricing review", [{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }], {
    speaker_names: { Them: "Alex Example" },
    speaker_suggestions: { Them: { name: "Alex Example", source: "call_window", confidence: "high",
      reason: "one_other_participant", person: "p2", at: at(10, 6, 9, 25) } },
  }),
];

/** RFC 7396 merge patch, as SQLite's json_patch applies it: a null member removes that key. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const merged: Record<string, unknown> = target !== null && typeof target === "object" && !Array.isArray(target)
    ? { ...(target as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = mergePatch(merged[key], value);
  }
  return merged;
}

const CALL_REVISION = "harness-call-rev-1";

/**
 * A Mac recording of a call with two remote people, transcribed by Private, with a name suggested for each of them,
 * and the Library rows: for the suggested-name screens.
 */
export const SUGGESTED_ROWS: FixtureRow[] = [
  ...LIBRARY_ROWS,
  {
    id: "note-call-suggested",
    source: "exo-voice-note",
    sourceId: "rec-call",
    title: "Offsite planning call",
    startedAt: at(10, 6, 9, 5),
    durationSecs: 96,
    commitHash: CALL_REVISION,
    metadata: {
      ...stored("exo-voice-note", "rec-call"),
      capture: { platform: "macos", channels: 2, duration_ms: 96_000 },
      transcription_engine: "private-cloud",
      transcript_provider: "tinycloud-private-transcription",
      inference_provider: "tinfoil",
      transcription_outcome: "transcribed",
      speaker_labels: "channels",
      speaker_name_suggestions: {
        hash: CALL_REVISION,
        model: "moonshotai/kimi-k3.1-pro",
        at: at(10, 6, 9, 8),
        names: {
          "Speaker 1": { name: "Alice Chen", basis: "self-introduction", quote: "I'm Alice Chen, I run the offsite planning" },
          "Speaker 2": { name: "Bob Stone", basis: "thanked", quote: "Thanks, Bob" },
        },
        dismissed: [],
      },
    },
    sentences: [
      { index: 0, speaker_name: "Me", channel: 0, text: "Thanks for making time. Could you each say who you are before we start?", start_time: 0, end_time: 9 },
      { index: 1, speaker_name: "Speaker 1", channel: 1, speaker_id: "A", text: "Sure. I'm Alice Chen, I run the offsite planning. The venue is booked and the agenda goes out Friday.", start_time: 10, end_time: 31 },
      { index: 2, speaker_name: "Speaker 2", channel: 1, speaker_id: "B", text: "I have the catering quote. It came in under budget, and I can share the numbers after this call.", start_time: 32, end_time: 55 },
      { index: 3, speaker_name: "Me", channel: 0, text: "Thanks, Bob. Then we only need the room list.", start_time: 56, end_time: 63 },
      { index: 4, speaker_name: "Speaker 1", channel: 1, speaker_id: "A", text: "I'll send it tomorrow morning.", start_time: 64, end_time: 70 },
      { index: 5, speaker_name: "Speaker 2", channel: 1, speaker_id: "B", text: "And I'll confirm the head count with the caterer once the list is in.", start_time: 71, end_time: 80 },
      { index: 6, speaker_name: "Me", channel: 0, text: "Good. Anything else before we close?", start_time: 81, end_time: 86 },
      { index: 7, speaker_name: "Speaker 1", channel: 1, speaker_id: "A", text: "Only that the agenda needs your sign-off by Thursday.", start_time: 87, end_time: 95 },
    ],
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
      // Match listMeetingsRead's `ORDER BY started_at DESC`; the Capture
      // Recent harness relies on the newest fixture row being first.
      const newestFirst = [...rows].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return { ok: true, data: { rows: newestFirst.map((r) => [r.id, r.source, r.sourceId, r.title, r.startedAt, r.durationSecs]) } };
    }
    if (sql.includes("FROM connector_meeting g") && sql.includes("transcription_outcome")) {
      const row = rows.find((r) => {
        if (r.sourceId !== params[0] || r.source !== "exo-voice-note") return false;
        const outcome = r.metadata.transcription_outcome;
        return outcome === "transcribed" || outcome === "no_speech"
          || (outcome == null && typeof r.metadata.transcript_text === "string" && r.metadata.transcript_text.trim().length > 0);
      });
      return { ok: true, data: { rows: row ? [[row.id, JSON.stringify(row.metadata)]] : [] } };
    }
    if (sql.includes("SELECT metadata FROM connector_meeting WHERE id = ?")) {
      const row = rows.find((r) => r.id === params[0]);
      return { ok: true, data: { rows: row ? [[JSON.stringify(row.metadata)]] : [] } };
    }
    // A note's committed transcript (`readTranscriptCommit`): the table is there once a fixture row has a commit.
    if (sql.includes("FROM sqlite_schema WHERE type = 'table' AND name = 'voice_note_transcript'")) {
      return { ok: true, data: { rows: rows.some((r) => r.commitHash !== undefined) ? [[1]] : [] } };
    }
    if (sql.includes("FROM voice_note_transcript WHERE source_id = ?")) {
      const row = rows.find((r) => r.sourceId === params[0] && r.commitHash !== undefined);
      return { ok: true, data: { rows: row ? [[row.sourceId, 1, row.commitHash, transcriptKvKey(row.source, row.sourceId), "transcribed",
        row.sentences.map((sentence) => sentence.text).join(" ").slice(0, 280), row.metadata.transcription_engine ?? null,
        row.metadata.transcript_provider ?? null, null, null, 1, "[]", row.startedAt, row.startedAt]] : [] } };
    }
    return { ok: true, data: { rows: [] } };
  };
  // The speaker-name writes (TC-2189), as the SQL applies them: one label merged into the row's `speaker_names`
  // (a null name clears it), then the map dropped once it is empty.
  // Names in the call: that write is now one merge patch, which also drops the label's suggestion on a row that has
  // suggestions, and `speaker_suggestions` is dropped once it is empty too. Those statements are handled first; the
  // write of the older form stays below.
  const execute = async (sql: string, params: unknown[] = []) => {
    // A dismissed name suggestion (`speaker_name_suggestions`), kept only where the stored suggestions are still
    // those the note showed.
    if (sql.includes("speaker_name_suggestions.dismissed")) {
      const [dismissed, , rowId, hash] = params as [string, string, string, string];
      const suggestions = rows.find((r) => r.id === rowId)?.metadata.speaker_name_suggestions as { hash?: string; dismissed?: unknown } | undefined;
      if (suggestions?.hash !== hash) return { ok: true, data: { changes: 0 } };
      suggestions.dismissed = JSON.parse(dismissed);
      return { ok: true, data: { changes: 1 } };
    }
    if (sql.includes("call_participants")) return { ok: true, data: { changes: 0 } };
    if (sql.includes("json_patch") && sql.includes("speaker_suggestions")) {
      const [withSuggestions, namesOnly, , rowId] = params as [string, string, string, string];
      const row = rows.find((r) => r.id === rowId);
      if (!row) return { ok: true, data: { changes: 0 } };
      const suggestions = row.metadata.speaker_suggestions;
      const hasSuggestions = suggestions !== null && typeof suggestions === "object" && !Array.isArray(suggestions);
      row.metadata = mergePatch(row.metadata, JSON.parse(hasSuggestions ? withSuggestions : namesOnly)) as Record<string, unknown>;
      return { ok: true, data: { changes: 1 } };
    }
    if (!sql.includes("speaker_names")) return { ok: true, data: { changes: 0 } };
    if (sql.includes("json_patch")) {
      const [label, shown, , rowId] = params as [string, string | null, string, string];
      const row = rows.find((r) => r.id === rowId);
      if (!row) return { ok: true, data: { changes: 0 } };
      const names = { ...((row.metadata.speaker_names as Record<string, string> | undefined) ?? {}) };
      if (shown === null) delete names[label];
      else names[label] = shown;
      row.metadata.speaker_names = names;
      return { ok: true, data: { changes: 1 } };
    }
    const row = rows.find((r) => r.id === params[0]);
    const names = row?.metadata.speaker_names as Record<string, string> | undefined;
    if (row && names && Object.keys(names).length === 0) delete row.metadata.speaker_names;
    const suggested = row?.metadata.speaker_suggestions;
    if (row && suggested !== null && typeof suggested === "object" && Object.keys(suggested).length === 0) delete row.metadata.speaker_suggestions;
    return { ok: true, data: { changes: row ? 1 : 0 } };
  };
  const get = async (key: string) => {
    const row = rows.find((r) => transcriptKvKey(r.source, r.sourceId) === key);
    return row ? { ok: true, data: { data: row.sentences, headers: {} } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "harness: nothing stored" } };
  };
  const sql = { db: () => ({ query, execute }) };
  const kv = new Proxy({ get } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : (harnessTcw.kv as unknown as Record<string | symbol, unknown>)[key]),
  });
  return new Proxy(harnessTcw, {
    get: (target, key) => (key === "sql" ? sql : key === "kv" ? kv : key === "spaceId" ? "harness-library" : Reflect.get(target, key)),
  }) as TinyCloudWeb;
}

/** The lines of the three-person call: Them 1 is Alex Example (p2), Them 2 is Dana Lee (p3). */
const CALL_SPEAKER_LINES: FirefliesSentence[] = [
  { index: 0, speaker_name: "Me", channel: 0, text: "Thanks, both. Where are we with the launch?", start_time: 0, end_time: 4 },
  { index: 1, speaker_name: "Them 1", speaker_id: "call:p2", channel: 1, text: "The press kit is ready and the pricing page is nearly done.", start_time: 4.6, end_time: 10 },
  { index: 2, speaker_name: "Them 2", speaker_id: "call:p3", channel: 1, text: "Support has the new help articles. We need the date to schedule the emails.", start_time: 10.7, end_time: 17 },
  { index: 3, speaker_name: "Me", channel: 0, text: "Let's say the fourteenth.", start_time: 17.5, end_time: 19.5 },
  { index: 4, speaker_name: "Them 1", speaker_id: "call:p2", channel: 1, text: "That works for the press side.", start_time: 20, end_time: 22.5 },
  { index: 5, speaker_name: "Them 2", speaker_id: "call:p3", channel: 1, text: "Then I'll book the emails for that morning.", start_time: 23, end_time: 26 },
];

/**
 * Who spoke when: a Mac recording of a three-person call, transcribed on the Mac, whose remote lines carry "Them 1" and
 * "Them 2" with the person each was; the row holds each label's suggested name.
 */
export const CALL_SPEAKER_ROWS: FixtureRow[] = [
  ...CALL_NAME_ROWS,
  {
    ...callRecording("call-three", "Launch review", [
      { id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }], {
      transcription_engine: "whispercpp",
      transcript_provider: "whispercpp",
      inference_provider: undefined,
      // The body is shown only when its text is the row's.
      transcript_text: CALL_SPEAKER_LINES.map((line) => line.text).join(" "),
      speaker_names: { "Them 1": "Alex Example", "Them 2": "Dana Lee" },
      speaker_suggestions: {
        "Them 1": { name: "Alex Example", source: "call_window", confidence: "high", reason: "speaking_marker", person: "p2", at: at(10, 6, 9, 40) },
        "Them 2": { name: "Dana Lee", source: "call_window", confidence: "high", reason: "speaking_marker", person: "p3", at: at(10, 6, 9, 40) },
      },
      speaker_suggestions_made: { "Them 1": at(10, 6, 9, 40), "Them 2": at(10, 6, 9, 40) },
    }),
    sentences: CALL_SPEAKER_LINES,
  },
];

const NAMED_CALL_REVISION = "harness-call-one-rev-1";

/**
 * The 1:1 call whose "Them" already carries the name taken from the call window (marked Suggested), on a row that
 * also holds a model's suggestion for that label: the label shows the mark and no second suggestion.
 */
export const NAMED_AND_SUGGESTED_ROWS: FixtureRow[] = [
  ...LIBRARY_ROWS,
  {
    ...callRecording("call-one-named", "Pricing review", [{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }], {
      speaker_names: { Them: "Alex Example" },
      speaker_suggestions: { Them: { name: "Alex Example", source: "call_window", confidence: "high",
        reason: "one_other_participant", person: "p2", at: at(10, 6, 9, 25) } },
      speaker_name_suggestions: { hash: NAMED_CALL_REVISION, model: "moonshotai/kimi-k3.1-pro", at: at(10, 6, 9, 27),
        names: { Them: { name: "Alex", basis: "thanked", quote: "Thanks, Alex" } }, dismissed: [] },
    }),
    commitHash: NAMED_CALL_REVISION,
  },
];
