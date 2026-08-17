import { describe, expect, test } from "bun:test";

import {
  GMEET_MEETING_SOURCE,
  GMEET_UNKNOWN_SPEAKER,
  buildGmeetSpeakerMap,
  deriveGmeetTitle,
  gmeetOffsetSeconds,
  gmeetParticipantDisplayName,
  normalizeGoogleMeetTranscript,
  stripConferenceRecordPrefix,
} from "./gmeetNormalize";
import type { GmeetNormalizeInput, GmeetTranscriptBundle } from "./gmeetNormalize";
import type {
  GmeetConferenceRecord,
  GmeetParticipant,
  GmeetTranscriptEntry,
} from "./gmeetClient";

const RECORD_NAME = "conferenceRecords/1a2b3c4d-5e6f";
const RECORD_START = "2026-08-14T15:28:20.000Z";

function record(overrides: Partial<GmeetConferenceRecord> = {}): GmeetConferenceRecord {
  return { name: RECORD_NAME, startTime: RECORD_START, ...overrides };
}

function signedin(id: string, displayName: string | null): GmeetParticipant {
  return {
    name: `${RECORD_NAME}/participants/${id}`,
    signedinUser: { user: `users/${id}`, displayName },
  };
}

function entry(
  participantId: string | null,
  text: string,
  startTime: string,
  endTime?: string,
): GmeetTranscriptEntry {
  return {
    name: `${RECORD_NAME}/transcripts/t1/entries/${startTime}`,
    participant: participantId === null ? null : `${RECORD_NAME}/participants/${participantId}`,
    text,
    languageCode: "en-US",
    startTime,
    endTime: endTime ?? startTime,
  };
}

function bundle(
  id: string,
  entries: GmeetTranscriptEntry[],
  state = "FILE_GENERATED",
  exportUri?: string,
): GmeetTranscriptBundle {
  return {
    transcript: {
      name: `${RECORD_NAME}/transcripts/${id}`,
      state,
      docsDestination: exportUri ? { document: `documents/${id}`, exportUri } : null,
    },
    entries,
  };
}

function input(overrides: Partial<GmeetNormalizeInput> = {}): GmeetNormalizeInput {
  return {
    record: record(),
    participants: [signedin("alice", "Alice Doe"), signedin("bob", "Bob Roe")],
    transcripts: [
      bundle("t1", [
        entry("alice", "Hello there", "2026-08-14T15:28:26.132Z", "2026-08-14T15:28:29.500Z"),
        entry("bob", "Hi Alice", "2026-08-14T15:28:31.000Z", "2026-08-14T15:28:33.250Z"),
      ]),
    ],
    ...overrides,
  };
}

describe("stripConferenceRecordPrefix", () => {
  test("strips the conferenceRecords/ resource prefix", () => {
    expect(stripConferenceRecordPrefix("conferenceRecords/abc-123")).toBe("abc-123");
  });

  test("leaves an already-bare id alone and tolerates junk", () => {
    expect(stripConferenceRecordPrefix("abc-123")).toBe("abc-123");
    expect(stripConferenceRecordPrefix("/conferenceRecords/abc-123/")).toBe("abc-123");
    expect(stripConferenceRecordPrefix(null)).toBe("");
    expect(stripConferenceRecordPrefix(undefined)).toBe("");
  });
});

describe("gmeetOffsetSeconds", () => {
  const anchor = Date.parse(RECORD_START);

  test("converts absolute ISO to a seconds offset keeping ms precision", () => {
    expect(gmeetOffsetSeconds("2026-08-14T15:28:26.132Z", anchor)).toBe(6.132);
    expect(gmeetOffsetSeconds("2026-08-14T15:29:20.000Z", anchor)).toBe(60);
  });

  test("clamps at 0 for an entry stamped before the record start", () => {
    expect(gmeetOffsetSeconds("2026-08-14T15:28:19.000Z", anchor)).toBe(0);
    expect(gmeetOffsetSeconds(RECORD_START, anchor)).toBe(0);
  });

  test("returns null for missing or unparseable timestamps", () => {
    expect(gmeetOffsetSeconds(undefined, anchor)).toBeNull();
    expect(gmeetOffsetSeconds("", anchor)).toBeNull();
    expect(gmeetOffsetSeconds("not-a-date", anchor)).toBeNull();
  });
});

describe("gmeetParticipantDisplayName / buildGmeetSpeakerMap", () => {
  test("fallback chain: signedinUser → anonymousUser → phoneUser", () => {
    expect(gmeetParticipantDisplayName(signedin("a", "Alice Doe"))).toBe("Alice Doe");
    expect(
      gmeetParticipantDisplayName({
        name: "p/anon",
        signedinUser: { displayName: null },
        anonymousUser: { displayName: "Guest 1" },
      }),
    ).toBe("Guest 1");
    expect(
      gmeetParticipantDisplayName({
        name: "p/phone",
        anonymousUser: { displayName: "  " },
        phoneUser: { displayName: "+1 555…" },
      }),
    ).toBe("+1 555…");
  });

  test("returns null when no branch carries a name", () => {
    expect(gmeetParticipantDisplayName({ name: "p/none" })).toBeNull();
    expect(gmeetParticipantDisplayName(null)).toBeNull();
  });

  test("maps resource name → display name, with Unknown for a nameless participant", () => {
    const map = buildGmeetSpeakerMap([signedin("alice", "Alice Doe"), { name: "p/bot" }]);
    expect(map.get(`${RECORD_NAME}/participants/alice`)).toBe("Alice Doe");
    expect(map.get("p/bot")).toBe(GMEET_UNKNOWN_SPEAKER);
    expect(map.size).toBe(2);
  });
});

describe("deriveGmeetTitle", () => {
  const at = "2026-08-14T15:28:20.000Z";

  test("one, two, and three participants list every name", () => {
    expect(deriveGmeetTitle([signedin("a", "Alice")], at)).toBe("Meet with Alice — Aug 14");
    expect(deriveGmeetTitle([signedin("a", "Alice"), signedin("b", "Bob")], at)).toBe(
      "Meet with Alice, Bob — Aug 14",
    );
    expect(
      deriveGmeetTitle([signedin("a", "Alice"), signedin("b", "Bob"), signedin("c", "Carol")], at),
    ).toBe("Meet with Alice, Bob, Carol — Aug 14");
  });

  test("many participants collapse the tail into +N more", () => {
    const many = ["Alice", "Bob", "Carol", "Dave", "Erin"].map((n, i) => signedin(`p${i}`, n));
    expect(deriveGmeetTitle(many, at)).toBe("Meet with Alice, Bob, Carol +2 more — Aug 14");
  });

  test("unnamed participants are skipped; a nameless record still gets a title", () => {
    expect(deriveGmeetTitle([{ name: "p/bot" }, signedin("a", "Alice")], at)).toBe(
      "Meet with Alice — Aug 14",
    );
    expect(deriveGmeetTitle([{ name: "p/bot" }], at)).toBe("Google Meet — Aug 14");
    expect(deriveGmeetTitle([], at)).toBe("Google Meet — Aug 14");
  });

  test("duplicate display names appear once", () => {
    expect(deriveGmeetTitle([signedin("a", "Alice"), signedin("a2", "Alice")], at)).toBe(
      "Meet with Alice — Aug 14",
    );
  });

  test("an unparseable start time drops the date rather than the title", () => {
    expect(deriveGmeetTitle([signedin("a", "Alice")], null)).toBe("Meet with Alice");
    expect(deriveGmeetTitle([], "nonsense")).toBe("Google Meet");
  });

  test("the date is UTC-stable, not locale- or timezone-derived", () => {
    expect(deriveGmeetTitle([signedin("a", "Alice")], "2026-01-02T00:00:00.000Z")).toBe(
      "Meet with Alice — Jan 2",
    );
    expect(deriveGmeetTitle([signedin("a", "Alice")], "2026-12-31T23:59:59.000Z")).toBe(
      "Meet with Alice — Dec 31",
    );
  });
});

describe("normalizeGoogleMeetTranscript", () => {
  test("pins source to google-meet and strips the resource prefix from source_id", () => {
    const { meeting } = normalizeGoogleMeetTranscript(input());
    expect(meeting.source).toBe(GMEET_MEETING_SOURCE);
    expect(meeting.source).toBe("google-meet");
    expect(meeting.sourceId).toBe("1a2b3c4d-5e6f");
    expect(meeting.sourceId).not.toContain("/");
  });

  test("emits FirefliesSentence shape with offsets anchored on the record start", () => {
    const { sentences } = normalizeGoogleMeetTranscript(input());
    expect(sentences).toEqual([
      {
        index: 0,
        speaker_name: "Alice Doe",
        text: "Hello there",
        start_time: 6.132,
        end_time: 9.5,
      },
      {
        index: 1,
        speaker_name: "Bob Roe",
        text: "Hi Alice",
        start_time: 11,
        end_time: 13.25,
      },
    ]);
    expect(Object.keys(sentences[0]!).sort()).toEqual([
      "end_time",
      "index",
      "speaker_name",
      "start_time",
      "text",
    ]);
  });

  test("clamps an entry stamped before the record start at 0", () => {
    const { sentences } = normalizeGoogleMeetTranscript(
      input({
        transcripts: [
          bundle("t1", [
            entry("alice", "Early", "2026-08-14T15:28:10.000Z", "2026-08-14T15:28:22.000Z"),
          ]),
        ],
      }),
    );
    expect(sentences[0]!.start_time).toBe(0);
    expect(sentences[0]!.end_time).toBe(2);
  });

  test("sorts across ALL transcripts before assigning indexes", () => {
    const { sentences, meeting } = normalizeGoogleMeetTranscript(
      input({
        transcripts: [
          bundle("t2", [
            entry("bob", "second half A", "2026-08-14T15:30:00.000Z"),
            entry("bob", "second half B", "2026-08-14T15:31:00.000Z"),
          ]),
          bundle("t1", [
            entry("alice", "first half A", "2026-08-14T15:28:30.000Z"),
            entry("alice", "first half B", "2026-08-14T15:29:00.000Z"),
          ]),
        ],
      }),
    );
    expect(sentences.map((s) => s.text)).toEqual([
      "first half A",
      "first half B",
      "second half A",
      "second half B",
    ]);
    expect(sentences.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(sentences.map((s) => s.start_time)).toEqual([10, 40, 100, 160]);
    expect(meeting.metadata.transcript_count).toBe(2);
  });

  test("entries sharing a start offset keep arrival order deterministically", () => {
    const same = "2026-08-14T15:28:30.000Z";
    const { sentences } = normalizeGoogleMeetTranscript(
      input({
        transcripts: [bundle("t1", [entry("alice", "A", same), entry("bob", "B", same)])],
      }),
    );
    expect(sentences.map((s) => s.text)).toEqual(["A", "B"]);
  });

  test("a join miss falls back to Unknown and is counted, not swallowed", () => {
    const { meeting, sentences } = normalizeGoogleMeetTranscript(
      input({
        participants: [signedin("alice", "Alice Doe")],
        transcripts: [
          bundle("t1", [
            entry("alice", "Known speaker", "2026-08-14T15:28:30.000Z"),
            entry("ghost", "Unjoined speaker", "2026-08-14T15:28:40.000Z"),
            entry(null, "No participant at all", "2026-08-14T15:28:50.000Z"),
          ]),
        ],
      }),
    );
    expect(sentences.map((s) => s.speaker_name)).toEqual([
      "Alice Doe",
      GMEET_UNKNOWN_SPEAKER,
      GMEET_UNKNOWN_SPEAKER,
    ]);
    expect(meeting.metadata.speaker_join_misses).toBe(2);
  });

  test("a participant known but nameless resolves to Unknown without a join miss", () => {
    const bot: GmeetParticipant = { name: `${RECORD_NAME}/participants/bot` };
    const { meeting, sentences } = normalizeGoogleMeetTranscript(
      input({
        participants: [bot],
        transcripts: [bundle("t1", [entry("bot", "beep", "2026-08-14T15:28:30.000Z")])],
      }),
    );
    expect(sentences[0]!.speaker_name).toBe(GMEET_UNKNOWN_SPEAKER);
    expect(meeting.metadata.speaker_join_misses).toBe(0);
  });

  test("silent participants produce no sentences but still shape the title", () => {
    const { meeting, sentences } = normalizeGoogleMeetTranscript(
      input({
        participants: [signedin("alice", "Alice Doe"), signedin("bot", "Notetaker Bot")],
        transcripts: [bundle("t1", [entry("alice", "Only me talking", "2026-08-14T15:28:30.000Z")])],
      }),
    );
    expect(sentences).toHaveLength(1);
    expect(meeting.title).toBe("Meet with Alice Doe, Notetaker Bot — Aug 14");
    expect(meeting.participants).toEqual([
      { name: "Alice Doe", email: null },
      { name: "Notetaker Bot", email: null },
    ]);
  });

  test("empty and partial transcripts normalize to what exists", () => {
    const emptyRecord = normalizeGoogleMeetTranscript(
      input({ participants: [], transcripts: [] }),
    );
    expect(emptyRecord.sentences).toEqual([]);
    expect(emptyRecord.meeting.title).toBe("Google Meet — Aug 14");
    expect(emptyRecord.meeting.metadata.entry_count).toBe(0);

    const partial = normalizeGoogleMeetTranscript(
      input({
        transcripts: [
          bundle("t1", [], "STARTED"),
          bundle("t2", [entry("alice", "mid-meeting toggle", "2026-08-14T15:28:30.000Z")], "ENDED"),
        ],
      }),
    );
    expect(partial.sentences).toHaveLength(1);
    expect(partial.meeting.metadata.transcript_states).toEqual(["STARTED", "ENDED"]);
  });

  test("blank-text entries are skipped and counted rather than indexed", () => {
    const { meeting, sentences } = normalizeGoogleMeetTranscript(
      input({
        transcripts: [
          bundle("t1", [
            entry("alice", "   ", "2026-08-14T15:28:30.000Z"),
            entry("alice", "real text", "2026-08-14T15:28:40.000Z"),
          ]),
        ],
      }),
    );
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.index).toBe(0);
    expect(meeting.metadata.entry_count).toBe(2);
    expect(meeting.metadata.empty_entries_skipped).toBe(1);
  });

  test("missing endTime degrades to a zero-length sentence, never end < start", () => {
    const one: GmeetTranscriptEntry = {
      name: "e1",
      participant: `${RECORD_NAME}/participants/alice`,
      text: "no end",
      startTime: "2026-08-14T15:28:30.000Z",
      endTime: null,
    };
    const { sentences } = normalizeGoogleMeetTranscript(
      input({ transcripts: [{ transcript: { name: "t1" }, entries: [one] }] }),
    );
    expect(sentences[0]!.start_time).toBe(10);
    expect(sentences[0]!.end_time).toBe(10);
  });

  test("falls back to the earliest entry as anchor when the record has no startTime", () => {
    const { meeting, sentences } = normalizeGoogleMeetTranscript(
      input({
        record: { name: RECORD_NAME },
        transcripts: [
          bundle("t1", [
            entry("alice", "first", "2026-08-14T15:28:30.000Z"),
            entry("bob", "later", "2026-08-14T15:28:45.000Z"),
          ]),
        ],
      }),
    );
    expect(sentences.map((s) => s.start_time)).toEqual([0, 15]);
    expect(meeting.metadata.timestamp_anchor).toBe("entries");
    expect(meeting.startedAt).toBeNull();
  });

  test("carries record timing, docs artifact, and language into metadata", () => {
    const { meeting } = normalizeGoogleMeetTranscript(
      input({
        record: record({ endTime: "2026-08-14T16:00:20.000Z", space: "spaces/abc" }),
        transcripts: [
          bundle(
            "t1",
            [entry("alice", "hi", "2026-08-14T15:28:30.000Z")],
            "FILE_GENERATED",
            "https://docs.google.com/document/d/fake-doc/export?format=txt",
          ),
        ],
      }),
    );
    expect(meeting.startedAt).toBe("2026-08-14T15:28:20.000Z");
    expect(meeting.durationSecs).toBe(1920);
    expect(meeting.metadata.timestamp_anchor).toBe("record");
    expect(meeting.metadata.transcript_states).toEqual(["FILE_GENERATED"]);
    expect(meeting.metadata.docs_export_uris).toEqual([
      "https://docs.google.com/document/d/fake-doc/export?format=txt",
    ]);
    expect(meeting.metadata.language_code).toBe("en-US");
    expect(meeting.metadata.space).toBe("spaces/abc");
    expect(meeting.metadata.participant_count).toBe(2);
  });

  test("omits the docs artifact until a transcript reaches FILE_GENERATED", () => {
    const { meeting } = normalizeGoogleMeetTranscript(
      input({ transcripts: [bundle("t1", [], "ENDED")] }),
    );
    expect(meeting.metadata.docs_export_uris).toBeUndefined();
    expect(meeting.metadata.transcript_states).toEqual(["ENDED"]);
  });

  test("duration falls back to the last sentence end when the record has no endTime", () => {
    const { meeting } = normalizeGoogleMeetTranscript(
      input({
        transcripts: [
          bundle("t1", [
            entry("alice", "hi", "2026-08-14T15:28:30.000Z", "2026-08-14T15:29:20.400Z"),
          ]),
        ],
      }),
    );
    expect(meeting.durationSecs).toBe(60);
  });

  test("leaves Fireflies-only fields null and assigns a fresh row id", () => {
    const a = normalizeGoogleMeetTranscript(input()).meeting;
    const b = normalizeGoogleMeetTranscript(input()).meeting;
    expect(a.organizerEmail).toBeNull();
    expect(a.summaryOverview).toBeNull();
    expect(a.summaryActionItems).toBeNull();
    expect(a.keywords).toBeNull();
    expect(a.meetingType).toBeNull();
    expect(a.id).not.toBe(b.id);
  });
});
