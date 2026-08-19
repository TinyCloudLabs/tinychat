import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  upsertMeeting,
  listKnownSourceIds,
  type NormalizedMeeting,
  type StoreResult,
  type UpsertMeetingOutcome,
} from "./connectors/connectorStore";
import type { FirefliesSentence } from "./connectors/firefliesClient";
import type { TranscriberMeeting, TranscriberTranscript } from "./transcriberApi";

/**
 * Save a TRANSCRIBER meeting into the user's OWN TinyCloud space, the way the Fireflies and
 * Google Meet connectors do: one `connector_meeting` row (SQL) plus the transcript body in KV
 * under the granted `connectors/` prefix, so the Meetings explorer lists it alongside the others.
 *
 * SIMPLE on purpose. The transcriber's transcript is mapped 1:1 onto the store's existing
 * sentence shape; a proper transcript-normalization step is being added separately by another
 * engineer and will slot in between `transcript()` and `upsertMeeting` here.
 */

/** `connector_meeting.source` for every meeting this module writes. */
export const TRANSCRIBER_MEETING_SOURCE = "tinycloud-transcriber";

/** Human label for the explorer chip. */
export const TRANSCRIBER_MEETING_SOURCE_LABEL = "TinyCloud Transcriber";

export function transcriberMeetingTitle(meeting: Pick<TranscriberMeeting, "meeting_url">): string {
  try {
    const u = new URL(meeting.meeting_url);
    const room = u.pathname.split("/").filter(Boolean).pop();
    return room ? `${room} (${u.host})` : u.host;
  } catch {
    return meeting.meeting_url;
  }
}

export function normalizeTranscriberTranscript(
  meeting: TranscriberMeeting,
  transcript: TranscriberTranscript,
): { meeting: NormalizedMeeting; sentences: FirefliesSentence[] } {
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const sentences: FirefliesSentence[] = segments.map((s, index) => ({
    index,
    speaker_name: s.speaker_name?.trim() ? s.speaker_name.trim() : null,
    text: s.text,
    start_time: Number.isFinite(s.start) ? s.start : 0,
    end_time: Number.isFinite(s.end) ? s.end : 0,
  }));

  const seen = new Set<string>();
  const participants: { name: string; email: string | null }[] = [];
  for (const sp of transcript.speakers ?? []) {
    const name = sp.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    participants.push({ name, email: null });
  }

  const lastEnd = sentences.length > 0 ? sentences[sentences.length - 1]!.end_time : 0;
  const durationSecs =
    typeof transcript.duration_seconds === "number" && Number.isFinite(transcript.duration_seconds)
      ? Math.round(transcript.duration_seconds)
      : lastEnd > 0
        ? Math.round(lastEnd)
        : null;

  return {
    meeting: {
      id: crypto.randomUUID(),
      source: TRANSCRIBER_MEETING_SOURCE,
      sourceId: meeting.id,
      title: transcriberMeetingTitle(meeting),
      startedAt: meeting.started_at ?? meeting.created_at ?? null,
      durationSecs,
      organizerEmail: null,
      participants,
      summaryOverview: null,
      summaryActionItems: null,
      keywords: null,
      meetingType: null,
      metadata: {
        meeting_url: meeting.meeting_url,
        platform: meeting.platform,
        language: transcript.language ?? null,
        transcript_text: transcript.text ?? null,
      },
    },
    sentences,
  };
}

/** Write (or refresh) the meeting in the user's space. Idempotent by `(source, sourceId)`. */
export async function saveTranscriberMeeting(
  tcw: TinyCloudWeb,
  meeting: TranscriberMeeting,
  transcript: TranscriberTranscript,
): Promise<StoreResult<UpsertMeetingOutcome>> {
  const normalized = normalizeTranscriberTranscript(meeting, transcript);
  return upsertMeeting(tcw, normalized.meeting, normalized.sentences);
}

/** The transcriber meeting ids already saved in this space. */
export function listSavedTranscriberMeetingIds(tcw: TinyCloudWeb): Promise<StoreResult<string[]>> {
  return listKnownSourceIds(tcw, TRANSCRIBER_MEETING_SOURCE);
}
