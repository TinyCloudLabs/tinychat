// Saving a transcriber meeting into the user's space: the mapping onto the shared connector
// store shape (connector_meeting row + sentence body), and the explorer registration.
import { describe, expect, test } from "bun:test";

import {
  TRANSCRIBER_MEETING_SOURCE,
  normalizeTranscriberTranscript,
  transcriberMeetingTitle,
} from "./transcriberSave";
import { EXPLORER_MEETING_SOURCES, meetingSourceLabel } from "./connectors/meetingExplorer";
import type { TranscriberMeeting, TranscriberTranscript } from "./transcriberApi";

const meeting: TranscriberMeeting = {
  id: "mtg_01ABC",
  status: "completed",
  platform: "jitsi",
  meeting_url: "https://meet.ffmuc.net/TinyCloudZcash",
  bot: { name: "TinyCloud Notetaker", joined_at: "2026-08-19T09:37:56.729Z" },
  created_at: "2026-08-19T09:37:35.245Z",
  started_at: "2026-08-19T09:37:56.729Z",
  ended_at: "2026-08-19T09:39:40.000Z",
};

const transcript: TranscriberTranscript = {
  meeting_id: "mtg_01ABC",
  status: "completed",
  language: "en",
  duration_seconds: 102.54,
  speakers: [
    { id: "speaker_0", name: "Alice" },
    { id: "speaker_1", name: "Alice" },
    { id: "speaker_2", name: " " },
  ],
  segments: [
    { id: "seg_001", speaker_id: "speaker_0", speaker_name: "Alice", start: 32.967, end: 33.967, text: "QUICK BROWN" },
    { id: "seg_002", speaker_id: "speaker_0", speaker_name: "Alice", start: 48.658, end: 50.39, text: "Hello from Alice." },
  ],
  text: "Alice: QUICK BROWN\nAlice: Hello from Alice.",
};

describe("normalizeTranscriberTranscript", () => {
  test("maps onto the connector store shape, keyed by (source, meeting id)", () => {
    const { meeting: row, sentences } = normalizeTranscriberTranscript(meeting, transcript);
    expect(row.source).toBe(TRANSCRIBER_MEETING_SOURCE);
    expect(row.sourceId).toBe("mtg_01ABC");
    expect(row.title).toBe("TinyCloudZcash (meet.ffmuc.net)");
    expect(row.startedAt).toBe("2026-08-19T09:37:56.729Z");
    expect(row.durationSecs).toBe(103);
    expect(row.participants).toEqual([{ name: "Alice", email: null }]);
    expect(row.metadata).toMatchObject({ meeting_url: meeting.meeting_url, platform: "jitsi", language: "en" });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sentences).toEqual([
      { index: 0, speaker_name: "Alice", text: "QUICK BROWN", start_time: 32.967, end_time: 33.967 },
      { index: 1, speaker_name: "Alice", text: "Hello from Alice.", start_time: 48.658, end_time: 50.39 },
    ]);
  });

  test("falls back to the last segment end for duration and to created_at for start", () => {
    const { meeting: row } = normalizeTranscriberTranscript(
      { ...meeting, started_at: null },
      { ...transcript, duration_seconds: undefined },
    );
    expect(row.durationSecs).toBe(50);
    expect(row.startedAt).toBe("2026-08-19T09:37:35.245Z");
  });

  test("an empty transcript still yields a row", () => {
    const { meeting: row, sentences } = normalizeTranscriberTranscript(meeting, {
      meeting_id: "mtg_01ABC",
      status: "completed",
    });
    expect(sentences).toEqual([]);
    expect(row.durationSecs).toBeNull();
    expect(row.participants).toEqual([]);
  });

  test("title degrades to the raw url", () => {
    expect(transcriberMeetingTitle({ meeting_url: "garbage" })).toBe("garbage");
  });
});

describe("explorer registration", () => {
  test("the transcriber source is listed and labelled", () => {
    expect(EXPLORER_MEETING_SOURCES).toContain(TRANSCRIBER_MEETING_SOURCE);
    expect(meetingSourceLabel(TRANSCRIBER_MEETING_SOURCE)).toBe("TinyCloud Transcriber");
  });
});
