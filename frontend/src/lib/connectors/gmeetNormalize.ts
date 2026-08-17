// Google Meet REST v2 records → NormalizedMeeting + FirefliesSentence[].
//
// See the connector plan §4.2 / §6 WP-B. This is a NEW normalizer, deliberately
// NOT a wrapper around normalizeFirefliesTranscript: that one hardcodes
// `source: "fireflies"` (connectorStore.ts ~:657-659), so reusing it would write
// Meet rows as Fireflies rows and corrupt FF counts, purge, and the Explorer.
// The source here is "google-meet", pinned by test.
//
// Three shape facts below are spike-verified live (2026-08-17):
//   1. Entries carry ABSOLUTE ISO-8601 UTC timestamps with sub-second precision
//      ("2026-08-10T15:28:26.132Z") — the persisted FirefliesSentence shape wants
//      seconds offsets, so every entry is anchored on conferenceRecord.startTime.
//   2. Entries name their speaker only as a `.../participants/<id>` RESOURCE —
//      display names require the participants join, which is done here.
//   3. Participants with ZERO entries are normal (bots, silent attendees). They
//      never appear in the sentences; they MAY appear in the derived title.
//
// Pure and synchronous — no fetch, no storage, no logging. Transcript text and
// participant names are private user data and are never logged, only returned.

import type { FirefliesSentence } from "./firefliesClient";
import type { NormalizedMeeting } from "./connectorStore";
import type {
  GmeetConferenceRecord,
  GmeetParticipant,
  GmeetTranscript,
  GmeetTranscriptEntry,
} from "./gmeetClient";

/** SQL `source` column value for every meeting this module produces. */
export const GMEET_MEETING_SOURCE = "google-meet";

/** Speaker name used when the participants join finds nothing usable. */
export const GMEET_UNKNOWN_SPEAKER = "Unknown";

/** Names shown in a derived title before it collapses to "+N more". */
export const GMEET_TITLE_MAX_NAMES = 3;

const CONFERENCE_RECORD_PREFIX = "conferenceRecords/";

// Fixed month table rather than toLocaleDateString: titles must not shift with
// the runtime's locale, ICU build, or timezone.
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** One transcript of a conference record, paired with its (paginated) entries. */
export interface GmeetTranscriptBundle {
  transcript: GmeetTranscript;
  /** May be empty or partial — a mid-meeting transcription toggle is normal. */
  entries?: GmeetTranscriptEntry[] | null;
}

export interface GmeetNormalizeInput {
  record: GmeetConferenceRecord;
  /** Full participants list of the record; the display-name join source. */
  participants?: GmeetParticipant[] | null;
  transcripts?: GmeetTranscriptBundle[] | null;
}

export interface GmeetNormalizeResult {
  meeting: NormalizedMeeting;
  sentences: FirefliesSentence[];
}

/**
 * Strip the `conferenceRecords/` resource prefix. Meeting `source_id` is the
 * BARE id everywhere in this codebase, and Phase-2's MEETING_ID_PATTERN rejects
 * "/" outright — so the prefix can never be allowed to leak into a row.
 */
export function stripConferenceRecordPrefix(name: string | null | undefined): string {
  if (typeof name !== "string") return "";
  const trimmed = name.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed.startsWith(CONFERENCE_RECORD_PREFIX)
    ? trimmed.slice(CONFERENCE_RECORD_PREFIX.length)
    : trimmed;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Round to millisecond resolution so float noise never reaches a stored row. */
function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Absolute ISO-8601 → seconds offset from `anchorMs`, clamped at 0. Sub-second
 * precision is preserved (…:26.132Z six seconds in ⇒ 6.132); an unparseable or
 * missing timestamp yields null so the caller can decide the fallback.
 */
export function gmeetOffsetSeconds(iso: unknown, anchorMs: number): number | null {
  const ms = parseIsoMs(iso);
  if (ms === null) return null;
  return roundSeconds(Math.max(0, ms - anchorMs) / 1000);
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * The spike-confirmed fallback chain: signedinUser → anonymousUser → phoneUser.
 * Returns null when the participant carries no usable display name at all, so
 * callers can distinguish "unnamed" from the "Unknown" join-miss placeholder.
 */
export function gmeetParticipantDisplayName(
  participant: GmeetParticipant | null | undefined,
): string | null {
  if (!participant) return null;
  return firstNonEmpty(
    participant.signedinUser?.displayName,
    participant.anonymousUser?.displayName,
    participant.phoneUser?.displayName,
  );
}

/**
 * Map participant RESOURCE name → display name. Entries reference speakers only
 * by resource name, so without this join every sentence would read "Unknown".
 */
export function buildGmeetSpeakerMap(
  participants: readonly GmeetParticipant[] | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const participant of participants ?? []) {
    const key = typeof participant?.name === "string" ? participant.name.trim() : "";
    if (key.length === 0) continue;
    map.set(key, gmeetParticipantDisplayName(participant) ?? GMEET_UNKNOWN_SPEAKER);
  }
  return map;
}

/** Display names of the participants that have one, deduped, in list order. */
function namedParticipants(
  participants: readonly GmeetParticipant[] | null | undefined,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const participant of participants ?? []) {
    const name = gmeetParticipantDisplayName(participant);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** "Aug 14" from an ISO instant, in UTC. Null when unparseable. */
function shortDateUtc(iso: unknown): string | null {
  const ms = parseIsoMs(iso);
  if (ms === null) return null;
  const d = new Date(ms);
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Participants-derived title — "Meet with Alice, Bob — Aug 14" (plan §4.2).
 * No Calendar or Drive lookup: those scopes are deliberately out of bounds.
 * Unnamed participants are left out of the name list; with none left the title
 * degrades to a plain "Google Meet — Aug 14" rather than "Meet with Unknown".
 */
export function deriveGmeetTitle(
  participants: readonly GmeetParticipant[] | null | undefined,
  startTime: string | null | undefined,
): string {
  const names = namedParticipants(participants);
  const date = shortDateUtc(startTime);
  const suffix = date ? ` — ${date}` : "";

  if (names.length === 0) return `Google Meet${suffix}`;

  const shown = names.slice(0, GMEET_TITLE_MAX_NAMES);
  const rest = names.length - shown.length;
  const people = rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
  return `Meet with ${people}${suffix}`;
}

function toIsoOrNull(value: unknown): string | null {
  const ms = parseIsoMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

interface PendingSentence {
  ordinal: number;
  start: number;
  end: number;
  speaker: string;
  text: string;
}

/**
 * Turn one conference record — its participants and every transcript's entries —
 * into a NormalizedMeeting plus the FirefliesSentence[] persisted verbatim as
 * the transcript blob.
 *
 * Entries from ALL transcripts are merged, sorted by start offset, and only then
 * indexed 0..n: a record with two transcripts (a mid-meeting toggle) must read as
 * one continuous conversation, not two concatenated ones.
 */
export function normalizeGoogleMeetTranscript(
  input: GmeetNormalizeInput,
): GmeetNormalizeResult {
  const record = input.record;
  const participants = input.participants ?? [];
  const bundles = input.transcripts ?? [];
  const speakers = buildGmeetSpeakerMap(participants);

  // Anchor: the record's own startTime. When Google omits it (never seen in the
  // spike, but the field is optional in the API), fall back to the earliest entry
  // so offsets stay meaningful instead of collapsing to absolute epoch seconds.
  const recordStartMs = parseIsoMs(record?.startTime);
  let earliestEntryMs: number | null = null;
  for (const bundle of bundles) {
    for (const entry of bundle?.entries ?? []) {
      const ms = parseIsoMs(entry?.startTime);
      if (ms !== null && (earliestEntryMs === null || ms < earliestEntryMs)) earliestEntryMs = ms;
    }
  }
  const anchorMs = recordStartMs ?? earliestEntryMs ?? 0;
  const timestampAnchor =
    recordStartMs !== null ? "record" : earliestEntryMs !== null ? "entries" : "none";

  const pending: PendingSentence[] = [];
  const transcriptStates: string[] = [];
  const docsExportUris: string[] = [];
  let languageCode: string | null = null;
  let speakerJoinMisses = 0;
  let emptyEntriesSkipped = 0;
  let entryCount = 0;
  let ordinal = 0;

  for (const bundle of bundles) {
    const transcript = bundle?.transcript;
    if (transcript) {
      const state = firstNonEmpty(
        typeof transcript.state === "string" ? transcript.state : null,
      );
      // Present even when repeated: the state mix of a record is the signal
      // (a STARTED transcript means the artifact is still being written).
      if (state) transcriptStates.push(state);
      // docsDestination.exportUri only materializes at state FILE_GENERATED —
      // the Docs artifact lags the entries, so its absence is expected, not a bug.
      const exportUri = firstNonEmpty(transcript.docsDestination?.exportUri);
      if (exportUri) docsExportUris.push(exportUri);
    }

    for (const entry of bundle?.entries ?? []) {
      if (!entry) continue;
      entryCount++;

      // languageCode is spike-confirmed present on entries but FirefliesSentence
      // has no slot for it — dropped from the sentence, surfaced once in metadata.
      if (languageCode === null) languageCode = firstNonEmpty(entry.languageCode);

      const text = typeof entry.text === "string" ? entry.text : "";
      if (text.trim().length === 0) {
        // Not a silent drop: counted in metadata below.
        emptyEntriesSkipped++;
        continue;
      }

      const participantName = typeof entry.participant === "string" ? entry.participant.trim() : "";
      const joined = participantName.length > 0 ? speakers.get(participantName) : undefined;
      if (joined === undefined) speakerJoinMisses++;

      const start = gmeetOffsetSeconds(entry.startTime, anchorMs) ?? 0;
      const end = gmeetOffsetSeconds(entry.endTime, anchorMs);

      pending.push({
        ordinal: ordinal++,
        start,
        // A missing/garbled endTime degrades to a zero-length sentence rather
        // than an end before its start.
        end: end === null ? start : Math.max(start, end),
        speaker: joined ?? GMEET_UNKNOWN_SPEAKER,
        text,
      });
    }
  }

  // Sort across ALL transcripts, then index — ties keep arrival order so the
  // result is deterministic for entries sharing a timestamp.
  pending.sort((a, b) => (a.start === b.start ? a.ordinal - b.ordinal : a.start - b.start));

  const sentences: FirefliesSentence[] = pending.map((p, index) => ({
    index,
    speaker_name: p.speaker,
    text: p.text,
    start_time: p.start,
    end_time: p.end,
  }));

  const startedAt = toIsoOrNull(record?.startTime);
  const recordEndMs = parseIsoMs(record?.endTime);
  const lastEnd = sentences.length > 0 ? sentences[sentences.length - 1]!.end_time : 0;
  let durationSecs: number | null = null;
  if (recordStartMs !== null && recordEndMs !== null && recordEndMs >= recordStartMs) {
    durationSecs = Math.round((recordEndMs - recordStartMs) / 1000);
  } else if (lastEnd > 0) {
    durationSecs = Math.round(lastEnd);
  }

  const metadata: Record<string, unknown> = {
    conference_record: typeof record?.name === "string" ? record.name : "",
    participant_count: participants.length,
    entry_count: entryCount,
    transcript_count: bundles.length,
    speaker_join_misses: speakerJoinMisses,
    timestamp_anchor: timestampAnchor,
  };
  if (transcriptStates.length > 0) metadata.transcript_states = transcriptStates;
  if (docsExportUris.length > 0) metadata.docs_export_uris = docsExportUris;
  if (languageCode !== null) metadata.language_code = languageCode;
  if (emptyEntriesSkipped > 0) metadata.empty_entries_skipped = emptyEntriesSkipped;
  if (typeof record?.space === "string" && record.space.length > 0) metadata.space = record.space;

  const meeting: NormalizedMeeting = {
    id: crypto.randomUUID(),
    source: GMEET_MEETING_SOURCE,
    sourceId: stripConferenceRecordPrefix(record?.name),
    title: deriveGmeetTitle(participants, record?.startTime),
    startedAt,
    durationSecs,
    // The Meet API exposes no organizer email under these scopes, and
    // signedinUser.user is a People API id — never an address. Honest null
    // beats a guessed one.
    organizerEmail: null,
    // Same convention as the Fireflies normalizer: named participants only,
    // deduped, first occurrence wins. Unnamed ones are not lost — the raw count
    // is in metadata.participant_count.
    participants: namedParticipants(participants).map((name) => ({ name, email: null })),
    summaryOverview: null,
    summaryActionItems: null,
    keywords: null,
    meetingType: null,
    metadata,
  };

  return { meeting, sentences };
}
