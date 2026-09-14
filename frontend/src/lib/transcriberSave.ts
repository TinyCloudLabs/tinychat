import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  publishConnectorMeeting,
  listKnownSourceIds,
  type NormalizedMeeting,
  type StoreResult,
  type UpsertMeetingOutcome,
} from "./connectors/connectorStore";
import type { FirefliesSentence } from "./connectors/firefliesClient";
import type { TranscriberMeeting, TranscriberTranscript } from "./transcriberApi";

/** Publish the current original transcriber artifact under the shared fenced catalog. */

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
        capture: transcript.capture ?? meeting.capture ?? null,
        transcript_provider: transcript.provider ?? meeting.transcript_provider ?? null,
        fallback_from: transcript.fallback_from ?? meeting.fallback_from ?? null,
        fallback_reason: transcript.fallback_reason ?? meeting.fallback_reason ?? null,
      },
    },
    sentences,
  };
}

/** Write (or refresh) the meeting in the user's space. Idempotent by `(source, sourceId)`. */
export async function saveTranscriberMeeting(
  tcw: TinyCloudWeb,
  sourceId: string,
  fetchCurrent: () => Promise<{ meeting: TranscriberMeeting; transcript: TranscriberTranscript }>,
): Promise<StoreResult<UpsertMeetingOutcome>> {
  return publishConnectorMeeting(tcw, { source: TRANSCRIBER_MEETING_SOURCE, sourceId }, async () => {
    const { meeting, transcript } = await fetchCurrent();
    if (meeting.id !== sourceId || transcript.meeting_id !== sourceId) throw new Error("Transcriber identity mismatch");
    const capture = transcript.capture ?? meeting.capture;
    const interruption = capture?.failure_reason ?? (capture?.completion_reason === "evicted" ? "evicted" : null)
      ?? (capture?.stop_requested_by === "join_deadline" ? "join_deadline" : null)
      ?? (capture?.provider_record_missing_at ? "provider_record_missing" : null);
    return { ...normalizeTranscriberTranscript(meeting, transcript), body: {
      basis: "transcript", schema: "json-records", raw: JSON.stringify(transcript.segments ?? []),
      originalExtent: "known", captureComplete: interruption ? false : null,
      omissions: interruption ? [{ code: "upstream_capture_incomplete", detail: interruption }] : [],
    } };
  });
}

/** The transcriber meeting ids already saved in this space. */
export function listSavedTranscriberMeetingIds(tcw: TinyCloudWeb): Promise<StoreResult<string[]>> {
  return listKnownSourceIds(tcw, TRANSCRIBER_MEETING_SOURCE);
}
