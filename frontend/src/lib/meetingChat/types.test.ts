import { describe, expect, test } from "bun:test";

import {
  CHUNK_HARD_CHARS,
  CHUNK_MAX_SPAN_SECS,
  CHUNK_TARGET_CHARS,
  MAX_EVIDENCE_READS,
  MAX_EXCERPTS,
  MEETING_CONTEXT_MAX_CHARS,
  type LocalKvRecordLocator,
  type MeetingCandidate,
  type MeetingRetrievalOutcome,
  type ServerMeetingLocator,
  type SqlSummaryLocator,
  type MeetingThreadState,
} from "./types";

const candidate: MeetingCandidate = {
  source: "fireflies",
  sourceId: "meeting-1",
  title: "Planning",
  startedAt: "2026-08-24T09:00:00.000Z",
  participantNames: ["Avery"],
  participantEmails: ["avery@example.test"],
  organizerEmail: "owner@example.test",
  hasSqlSummary: true,
  hasLocalRecord: false,
  hasLocalTranscript: false,
  hasServerSummary: true,
  hasServerTranscript: true,
  localRowId: "row-1",
  createdAt: "2026-08-24T09:00:00.000Z",
  updatedAt: "2026-08-24T09:05:00.000Z",
};

describe("meeting-chat shared contracts", () => {
  test("pins the evidence and context hard limits", () => {
    expect({
      MAX_EVIDENCE_READS,
      MAX_EXCERPTS,
      CHUNK_TARGET_CHARS,
      CHUNK_HARD_CHARS,
      CHUNK_MAX_SPAN_SECS,
      MEETING_CONTEXT_MAX_CHARS,
    }).toEqual({
      MAX_EVIDENCE_READS: 3,
      MAX_EXCERPTS: 4,
      CHUNK_TARGET_CHARS: 1_000,
      CHUNK_HARD_CHARS: 1_400,
      CHUNK_MAX_SPAN_SECS: 90,
      MEETING_CONTEXT_MAX_CHARS: 12_000,
    });
  });

  test("keeps discovery candidates and thread state content-free", () => {
    expect(Object.keys(candidate).sort()).toEqual([
      "createdAt",
      "hasLocalRecord",
      "hasLocalTranscript",
      "hasServerSummary",
      "hasServerTranscript",
      "hasSqlSummary",
      "localRowId",
      "organizerEmail",
      "participantEmails",
      "participantNames",
      "source",
      "sourceId",
      "startedAt",
      "title",
      "updatedAt",
    ]);

    const state: MeetingThreadState = {
      selected: { source: candidate.source, sourceId: candidate.sourceId },
      ambiguityChoices: [candidate],
    };
    expect(state).toEqual({
      selected: { source: "fireflies", sourceId: "meeting-1" },
      ambiguityChoices: [candidate],
    });
    expect(JSON.stringify(state)).not.toContain("summary");
    expect(JSON.stringify(state)).not.toContain("transcript");
    expect(JSON.stringify(state)).not.toContain("metadata");
    expect(JSON.stringify(state)).not.toContain("provenance");
  });

  test("keeps every retrieval result discriminated", () => {
    const sql: SqlSummaryLocator = {
      kind: "sql-summary",
      source: candidate.source,
      sourceId: candidate.sourceId,
      localRowId: "row-1",
    };
    const local: LocalKvRecordLocator = {
      kind: "local-kv-record",
      source: candidate.source,
      sourceId: candidate.sourceId,
    };
    const server: ServerMeetingLocator = {
      kind: "server-meeting",
      source: candidate.source,
      sourceId: candidate.sourceId,
    };
    const outcomes: MeetingRetrievalOutcome[] = [
      { status: "not-applicable" },
      { status: "clarification", choices: [candidate] },
      { status: "no-match", partial: false },
      { status: "no-content", meeting: candidate, partial: true },
      { status: "storage-error", partial: true },
      { status: "aborted" },
      {
        status: "grounded",
        meeting: candidate,
        evidence: {
          summary: "The team chose Tuesday.",
          summaryLocator: sql,
          transcript: null,
          transcriptLocator: null,
          reads: 1,
          partial: false,
          unavailableLocators: [local.kind, server.kind],
        },
        systemMessage: "untrusted meeting evidence",
        partial: false,
      },
    ];

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "not-applicable",
      "clarification",
      "no-match",
      "no-content",
      "storage-error",
      "aborted",
      "grounded",
    ]);
  });
});
