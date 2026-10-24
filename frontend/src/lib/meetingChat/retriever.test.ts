import { describe, expect, test } from "bun:test";

import {
  createBrowserMeetingTurnRetriever,
  detectMeetingIntent,
  MeetingRetriever,
  readMeetingEvidence,
  selectMeeting,
  SQL_MEETING_SUMMARY_QUERY,
} from "./retriever";
import { transcriptKvKey } from "../connectors/connectorStore";
import { rankMeetingExcerpts } from "./context";
import type { MeetingCandidate, MeetingCorpus } from "./types";

const NOW = new Date("2026-03-01T00:05:00.000Z");

function candidate(patch: Partial<MeetingCandidate> = {}): MeetingCandidate {
  return {
    source: "fireflies",
    sourceId: "meeting-1",
    title: "Planning",
    startedAt: "2026-02-28T10:00:00.000Z",
    participantNames: ["Avery Chen"],
    participantEmails: ["avery@example.test"],
    organizerEmail: "organizer@example.test",
    hasSqlSummary: false,
    hasLocalRecord: false,
    hasLocalTranscript: false,
    localRowId: null,
    createdAt: "2026-02-28T11:00:00.000Z",
    updatedAt: "2026-02-28T11:00:00.000Z",
    ...patch,
  };
}

function corpus(candidates: readonly MeetingCandidate[], partial = false): MeetingCorpus {
  return {
    candidates,
    lanes: {
      sql: partial ? { state: "failed", reason: "storage" } : { state: "healthy" },
      kv: { state: "healthy" },
    },
    partial,
  };
}

function intent(question: string) {
  const value = detectMeetingIntent(question, { now: NOW });
  if (value === null) throw new Error(`expected meeting intent for ${question}`);
  return value;
}

describe("detectMeetingIntent", () => {
  test("recognizes meeting nouns and only the supported retrieval grammar", () => {
    expect(detectMeetingIntent("Show me the meeting notes", { now: NOW })).toEqual(expect.objectContaining({
      hasMeetingNoun: true,
      hasRetrievalPhrase: true,
      hasStrongSelector: false,
    }));
    expect(detectMeetingIntent("What did we decide in the meeting?", { now: NOW })).toEqual(expect.objectContaining({
      hasMeetingNoun: true,
      hasRetrievalPhrase: true,
    }));

    // Generic topic questions must not trigger any meeting discovery.
    expect(detectMeetingIntent("Summarize the budget risks", { now: NOW })).toBeNull();
    expect(detectMeetingIntent("What did we decide about the budget?", { now: NOW })).toBeNull();
  });

  test("parses only explicit and deliberately small relative-date selectors", () => {
    expect(detectMeetingIntent("meeting on 2026-02-28", { now: NOW })?.date).toEqual({
      day: "2026-02-28",
      kind: "explicit",
    });
    expect(detectMeetingIntent("meeting on 2/28/2026", { now: NOW })?.date).toEqual({
      day: "2026-02-28",
      kind: "explicit",
    });
    expect(detectMeetingIntent("meeting on February 28", { now: NOW })?.date).toEqual({
      day: "2026-02-28",
      kind: "explicit",
    });
    expect(detectMeetingIntent("today's meeting", { now: NOW })?.date).toEqual({
      day: "2026-03-01",
      kind: "relative",
    });
    expect(detectMeetingIntent("yesterday's meeting", { now: NOW })?.date).toEqual({
      day: "2026-02-28",
      kind: "relative",
    });

    // Broad prose and impossible dates are deliberately not interpreted.
    expect(detectMeetingIntent("the meeting from last Friday", { now: NOW })?.date).toBeNull();
    expect(detectMeetingIntent("meeting on 2026-02-30", { now: NOW })?.date).toBeNull();
    expect(detectMeetingIntent("meeting from today and yesterday", { now: NOW })?.date).toBeNull();
  });

  test("recognizes latest, title/participant phrases, exact e-mail, and domains as selectors", () => {
    expect(detectMeetingIntent("latest meeting", { now: NOW })).toEqual(expect.objectContaining({
      latest: true,
      hasStrongSelector: true,
    }));
    expect(detectMeetingIntent('meeting titled "Q3 planning"', { now: NOW })?.phrases).toEqual(["Q3 planning"]);
    expect(detectMeetingIntent("meeting with Avery", { now: NOW })?.phrases).toEqual(["Avery"]);
    expect(detectMeetingIntent("meeting with avery@example.test", { now: NOW })).toEqual(expect.objectContaining({
      emails: ["avery@example.test"],
      emailDomains: ["example.test"],
      hasStrongSelector: true,
    }));
    expect(detectMeetingIntent("meeting with example.test", { now: NOW })?.emailDomains).toEqual(["example.test"]);
    expect(detectMeetingIntent("meeting with example.test", { now: NOW })?.phrases).toEqual([]);
    expect(detectMeetingIntent("Show me notes from the Budget Review meeting", { now: NOW })?.phrases).toEqual(["Budget Review"]);
  });

  test("routes natural speaker-attributed meeting questions to transcript evidence", () => {
    expect(detectMeetingIntent("What did Alice say in the latest meeting?", { now: NOW })).toEqual(expect.objectContaining({
      latest: true,
      hasMeetingNoun: true,
      phrases: ["Alice"],
    }));
    expect(detectMeetingIntent("What did Alice say about the budget?", { now: NOW })).toBeNull();
  });

  test("accepts a referential follow-up only with selected in-session state", () => {
    expect(detectMeetingIntent("What did they decide?", { now: NOW })).toBeNull();
    expect(detectMeetingIntent("What did they decide?", {
      now: NOW,
      hasSelectedMeeting: true,
    })).toEqual(expect.objectContaining({
      hasReferentialFollowUp: true,
      hasMeetingNoun: false,
    }));
  });
});

describe("selectMeeting", () => {
  test("uses an explicit calendar date as a hard filter before all other selectors", () => {
    const february = candidate({ sourceId: "feb", title: "Planning", startedAt: "2026-02-28T09:00:00.000Z" });
    const march = candidate({ sourceId: "mar", title: "Planning", startedAt: "2026-03-01T09:00:00.000Z" });

    expect(selectMeeting(intent('meeting titled "Planning" on 2026-02-28'), corpus([march, february]))).toEqual({
      status: "selected",
      meeting: february,
    });
  });

  test("prioritizes exact e-mail, exact phrase, then the best title/participant token overlap", () => {
    const exactEmail = candidate({ sourceId: "email", title: "Other", participantNames: ["Someone Else"] });
    const title = candidate({ sourceId: "title", title: "Q3 Planning", participantEmails: ["other@example.test"] });
    const partialTitle = candidate({ sourceId: "tokens", title: "Q3 Strategy Roadmap", participantEmails: ["other@example.test"] });

    expect(selectMeeting(intent("meeting with avery@example.test"), corpus([title, exactEmail]))).toEqual({
      status: "selected",
      meeting: exactEmail,
    });
    expect(selectMeeting(intent('meeting titled "Q3 Planning"'), corpus([partialTitle, title]))).toEqual({
      status: "selected",
      meeting: title,
    });
    expect(selectMeeting(intent('meeting titled "Q3 strategy"'), corpus([partialTitle, title]))).toEqual({
      status: "selected",
      meeting: partialTitle,
    });
  });

  test("uses latest only after filtering and otherwise uses recency as a deterministic tie-breaker", () => {
    const oldPlanning = candidate({ sourceId: "old", title: "Planning", startedAt: "2026-02-27T10:00:00.000Z" });
    const newPlanning = candidate({ sourceId: "new", title: "Planning", startedAt: "2026-02-28T10:00:00.000Z" });
    const newestOther = candidate({ sourceId: "other", title: "Retrospective", startedAt: "2026-03-01T10:00:00.000Z" });

    expect(selectMeeting(intent('latest meeting titled "Planning"'), corpus([oldPlanning, newestOther, newPlanning]))).toEqual({
      status: "selected",
      meeting: newPlanning,
    });
    expect(selectMeeting(intent('meeting titled "Planning"'), corpus([oldPlanning, newPlanning]))).toEqual({
      status: "selected",
      meeting: newPlanning,
    });
  });

  test("applies natural title, participant, and bare-domain selectors before recency/latest", () => {
    const budget = candidate({ sourceId: "budget", title: "Budget Review", startedAt: "2026-02-27T10:00:00.000Z" });
    const newer = candidate({ sourceId: "newer", title: "Roadmap", startedAt: "2026-03-01T10:00:00.000Z" });
    expect(selectMeeting(intent("Show me notes from the Budget Review meeting"), corpus([newer, budget]))).toEqual({ status: "selected", meeting: budget });

    const alice = candidate({ sourceId: "alice", participantNames: ["Alice"], startedAt: "2026-02-27T10:00:00.000Z" });
    const bob = candidate({ sourceId: "bob", participantNames: ["Bob"], startedAt: "2026-03-01T10:00:00.000Z" });
    expect(selectMeeting(intent("What did Alice say in the latest meeting?"), corpus([bob, alice]))).toEqual({ status: "selected", meeting: alice });

    const domain = candidate({ sourceId: "domain", participantEmails: ["person@example.test"], organizerEmail: null });
    const other = candidate({ sourceId: "other-domain", participantEmails: ["person@else.test"], organizerEmail: null });
    expect(selectMeeting(intent("meeting with example.test"), corpus([other, domain]))).toEqual({ status: "selected", meeting: domain });
  });

  test("clarifies latest when the newest timestamp is tied or unavailable", () => {
    const tied = [candidate({ sourceId: "a" }), candidate({ sourceId: "b" })];
    expect(selectMeeting(intent("latest meeting"), corpus(tied))).toEqual(expect.objectContaining({ status: "clarification" }));
    const undated = [candidate({ sourceId: "u1", startedAt: null }), candidate({ sourceId: "u2", startedAt: null })];
    expect(selectMeeting(intent("latest meeting"), corpus(undated))).toEqual(expect.objectContaining({ status: "clarification" }));
    const mixed = [candidate({ sourceId: "dated" }), candidate({ sourceId: "undated", startedAt: null })];
    expect(selectMeeting(intent("latest meeting"), corpus(mixed))).toEqual(expect.objectContaining({ status: "clarification" }));
  });

  test("requires a selector without a selected thread and returns at most five stable clarification choices", () => {
    const choices = Array.from({ length: 6 }, (_, index) => candidate({
      sourceId: `id-${index}`,
      title: `Same title ${index}`,
      startedAt: "2026-02-28T10:00:00.000Z",
    }));

    expect(selectMeeting(intent("meeting notes"), corpus([...choices].reverse()))).toEqual({
      status: "clarification",
      choices: choices.slice(0, 5),
      truncated: true,
    });
    expect(selectMeeting(
      detectMeetingIntent("What did they decide?", { now: NOW, hasSelectedMeeting: true })!,
      corpus([...choices].reverse()),
      { selected: { source: "fireflies", sourceId: "id-5" } },
    )).toEqual({ status: "selected", meeting: choices[5] });
  });

  test("returns a stable clarification for unresolved ties and never claims no-match for a partial corpus", () => {
    const first = candidate({ sourceId: "a", title: "Planning", startedAt: "2026-02-28T10:00:00.000Z" });
    const second = candidate({ sourceId: "b", title: "Planning", startedAt: "2026-02-28T10:00:00.000Z" });

    expect(selectMeeting(intent('meeting titled "Planning"'), corpus([second, first]))).toEqual({
      status: "clarification",
      choices: [first, second],
    });
    expect(selectMeeting(intent('meeting titled "Absent"'), corpus([], false))).toEqual({
      status: "no-match",
      partial: false,
    });
    expect(selectMeeting(intent('meeting titled "Absent"'), corpus([], true))).toEqual({
      status: "storage-error",
      partial: true,
    });
    expect(selectMeeting(intent("meeting notes"), corpus([first, second], true))).toEqual(expect.objectContaining({
      status: "clarification",
      partial: true,
    }));
  });

  test("does not merge similar metadata while selecting and preserves result ordering across input order", () => {
    const alpha = candidate({ source: "fireflies", sourceId: "a", title: "Same", startedAt: "2026-02-28T10:00:00.000Z" });
    const beta = candidate({ source: "google-meet", sourceId: "b", title: "Same", startedAt: "2026-02-28T10:00:00.000Z" });
    const selected = { source: "google-meet", sourceId: "b" };
    const followUp = detectMeetingIntent("What did they decide?", { now: NOW, hasSelectedMeeting: true })!;

    expect(selectMeeting(followUp, corpus([alpha, beta]), { selected })).toEqual({ status: "selected", meeting: beta });
    expect(selectMeeting(followUp, corpus([beta, alpha]), { selected })).toEqual({ status: "selected", meeting: beta });
  });

  test("never freshly selects opaque KV-only identities, except an exact selected reference", () => {
    const opaque = candidate({
      sourceId: "opaque", title: null, startedAt: null, participantNames: [], participantEmails: [], organizerEmail: null,
      hasLocalRecord: true,
    });
    expect(selectMeeting(intent("latest meeting"), corpus([opaque]))).toEqual({ status: "no-match", partial: false });
    const followUp = detectMeetingIntent("What did they decide?", { now: NOW, hasSelectedMeeting: true })!;
    expect(selectMeeting(followUp, corpus([opaque]), { selected: { source: "fireflies", sourceId: "opaque" } })).toEqual({
      status: "selected", meeting: opaque,
    });
    expect(selectMeeting(intent("latest meeting"), corpus([opaque]), { selected: { source: "fireflies", sourceId: "opaque" } })).toEqual({
      status: "no-match", partial: false,
    });
  });
});

describe("MeetingRetriever ephemeral thread state", () => {
  test("keeps selected references per thread and reuses them for referential follow-ups", () => {
    const retriever = new MeetingRetriever();
    const alpha = candidate({ sourceId: "alpha", title: "Alpha" });
    const beta = candidate({ sourceId: "beta", title: "Beta" });
    const meetings = corpus([alpha, beta]);

    const initialIntent = retriever.detectIntent("thread-a", 'meeting titled "Alpha"', { now: NOW });
    expect(initialIntent).not.toBeNull();
    expect(retriever.selectMeeting("thread-a", initialIntent!, meetings)).toEqual({
      status: "selected",
      meeting: alpha,
    });

    const followUp = retriever.detectIntent("thread-a", "What did they decide?", { now: NOW });
    expect(followUp).not.toBeNull();
    expect(retriever.selectMeeting("thread-a", followUp!, meetings)).toEqual({
      status: "selected",
      meeting: alpha,
    });

    // A second thread neither sees the first selection nor becomes eligible
    // for a referential question simply because another thread made one.
    expect(retriever.detectIntent("thread-b", "What did they decide?", { now: NOW })).toBeNull();
    expect(retriever.getThreadState("thread-a")).toEqual({
      selected: { source: "fireflies", sourceId: "alpha" },
      ambiguityChoices: [],
    });
    expect(retriever.getThreadState("thread-b")).toEqual({
      selected: null,
      ambiguityChoices: [],
    });
  });

  test("resolves a prior ambiguity by one displayed title or date and consumes the choices", () => {
    const retriever = new MeetingRetriever();
    const february = candidate({ sourceId: "feb", title: "Planning", startedAt: "2026-02-28T10:00:00.000Z" });
    const march = candidate({ sourceId: "mar", title: "Retrospective", startedAt: "2026-03-01T10:00:00.000Z" });
    const tied = corpus([february, march]);

    const ambiguousIntent = retriever.detectIntent("thread", "meeting notes", { now: NOW });
    expect(retriever.selectMeeting("thread", ambiguousIntent!, tied)).toEqual({
      status: "clarification",
      choices: [march, february],
    });
    expect(retriever.resolveClarification("thread", "2026-02-28", NOW)).toEqual(february);
    expect(retriever.getThreadState("thread")).toEqual({
      selected: { source: "fireflies", sourceId: "feb" },
      ambiguityChoices: [],
    });

    // Repeating the reply cannot consume or alter the selected state again.
    expect(retriever.resolveClarification("thread", "2026-02-28", NOW)).toBeNull();

    const titleRetriever = new MeetingRetriever();
    const titleIntent = titleRetriever.detectIntent("thread", "meeting notes", { now: NOW });
    titleRetriever.selectMeeting("thread", titleIntent!, tied);
    expect(titleRetriever.resolveClarification("thread", "Retrospective", NOW)).toEqual(march);
  });

  test("keeps unresolved ambiguity intact and a new retriever starts with no persisted state", () => {
    const retriever = new MeetingRetriever();
    const first = candidate({ sourceId: "one", title: "Planning", startedAt: "2026-02-28T10:00:00.000Z" });
    const second = candidate({ sourceId: "two", title: "Planning", startedAt: "2026-02-28T11:00:00.000Z" });
    const choices = corpus([first, second]);
    const meetingIntent = retriever.detectIntent("thread", "meeting notes", { now: NOW });
    retriever.selectMeeting("thread", meetingIntent!, choices);

    expect(retriever.resolveClarification("thread", "Planning", NOW)).toBeNull();
    expect(retriever.getThreadState("thread").ambiguityChoices).toEqual([second, first]);

    // State is held only by this in-memory instance. A reload constructs a
    // fresh retriever and cannot access a thread-store or persistence API.
    expect(new MeetingRetriever().getThreadState("thread")).toEqual({
      selected: null,
      ambiguityChoices: [],
    });
  });

  test("resolves only exact offered choices and leaves unrelated dated prose pending", () => {
    const retriever = new MeetingRetriever();
    const choices = [candidate({ sourceId: "a" }), candidate({ sourceId: "b", startedAt: "2026-02-27T10:00:00.000Z" })];
    retriever.selectMeeting("thread", intent("meeting notes"), corpus(choices));
    expect(retriever.resolveClarification("thread", "My deadline is 2026-02-28", NOW)).toBeNull();
    expect(retriever.resolveClarification("thread", "2", NOW)?.sourceId).toBe("b");
  });
});

describe("browser meeting turn retriever", () => {
  test("does no discovery for ordinary chat and keeps selected evidence ephemeral", async () => {
    const calls: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const serial = async <T>(name: string, value: T): Promise<T> => {
      calls.push(name);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return value;
      } finally {
        active -= 1;
      }
    };
    const retriever = createBrowserMeetingTurnRetriever({
      tcw: {
        sql: {
          db: () => ({
            query: (query: string) => serial(
              "sql",
              query === SQL_MEETING_SUMMARY_QUERY
                ? { ok: true, data: { rows: [["Private meeting canary", null]] } }
                : query.includes("FROM connector_meeting")
                  ? { ok: true, data: { rows: [[
                    "row-1", "fireflies", "meeting-1", "Planning", "2026-02-28T10:00:00.000Z",
                    null, "[]", 1, "2026-02-28T11:00:00.000Z", "2026-02-28T11:00:00.000Z",
                  ]] } }
                  : { ok: true, data: { rows: [] } },
            ),
          }),
        },
        kv: {
          list: ({ path }: { path: string }) => serial(`list:${path}`, { ok: true, data: { keys: [] } }),
          get: () => serial("get", { ok: false, error: { code: "KV_NOT_FOUND" } }),
        },
      },
    } as never);

    expect(await retriever.retrieve({ threadId: "thread", question: "Explain token overlap." })).toEqual({
      status: "not-applicable",
    });
    expect(await retriever.retrieve({ threadId: "thread", question: "Please sync my calendar." })).toEqual({
      status: "not-applicable",
    });
    expect(await retriever.retrieve({ threadId: "thread", question: "Start the daily stand-up reminder." })).toEqual({
      status: "not-applicable",
    });
    expect(calls).toEqual([]);

    const outcome = await retriever.retrieve({ threadId: "thread", question: "latest meeting notes" });
    expect(outcome).toEqual(expect.objectContaining({
      status: "grounded",
      systemMessage: expect.stringContaining("Private meeting canary"),
    }));
    expect(calls).toEqual([
      "sql",
      "sql", // per-session transcript table format detection
      "list:xyz.tinycloud.tinychat/connectors/fireflies/meeting/",
      "list:xyz.tinycloud.tinychat/connectors/fireflies/transcript/",
      "sql", // the selected meeting's summary read
    ]);
    expect(maximumActive).toBe(1);
    // The retriever exposes only a transient outcome; it has no persisted
    // thread evidence API and future reference-only follow-ups re-read it.
    expect(JSON.stringify(retriever)).not.toContain("Private meeting canary");
  });
});

type StoredRead = { ok: true; data: { data: unknown } } | { ok: false; error: { code: string } };

function evidenceHarness(options: {
  sql?: () => Promise<{ ok: boolean; data?: { rows?: unknown } }>;
  kv?: (key: string) => Promise<StoredRead>;
} = {}) {
  const calls: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const enter = async <T>(name: string, read: () => Promise<T>): Promise<T> => {
    calls.push(name);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      return await read();
    } finally {
      active -= 1;
    }
  };
  return {
    calls,
    get maximumActive() { return maximumActive; },
    options: {
      tcw: {
        sql: {
          db: () => ({
            query: (sql: string) => enter(`sql:${sql}`, options.sql ?? (async () => ({ ok: true, data: { rows: [] } }))),
          }),
        },
        kv: {
          get: (key: string) => enter(`kv:${key}`, options.kv ?? (async () => ({ ok: false, error: { code: "KV_NOT_FOUND" } }))),
        },
      },
    },
  };
}

describe("readMeetingEvidence", () => {
  test("reads SQL summary first and stops once summary evidence is sufficient", async () => {
    const h = evidenceHarness({
      sql: async () => ({ ok: true, data: { rows: [["Approved the launch.", "Ship Friday."]] } }),
    });
    const selected = candidate({
      hasSqlSummary: true,
      localRowId: "local-1",
      hasLocalRecord: true,
      hasLocalTranscript: true,
    });

    const outcome = await readMeetingEvidence(selected, h.options as never);

    expect(outcome).toEqual({
      status: "evidence",
      evidence: expect.objectContaining({
        summary: "Overview:\nApproved the launch.\n\nAction items:\nShip Friday.",
        summaryLocator: { kind: "sql-summary", source: "fireflies", sourceId: "meeting-1", localRowId: "local-1" },
        transcript: null,
        reads: 1,
        partial: false,
      }),
    });
    expect(h.calls).toEqual([`sql:${SQL_MEETING_SUMMARY_QUERY}`]);
    expect(h.maximumActive).toBe(1);
  });

  test("returns transcript-only evidence from the listed local transcript", async () => {
    const h = evidenceHarness({
      kv: async () => ({ ok: true, data: { data: JSON.stringify([{ speaker_name: "Avery", text: "Transcript canary" }]) } }),
    });
    const selected = candidate({ hasLocalTranscript: true });

    const outcome = await readMeetingEvidence(selected, h.options as never);

    expect(outcome).toEqual({
      status: "evidence",
      evidence: expect.objectContaining({
        summary: null,
        transcript: [{ speaker_name: "Avery", text: "Transcript canary" }],
        transcriptLocator: { kind: "local-kv-transcript", source: "fireflies", sourceId: "meeting-1" },
        reads: 1,
      }),
    });
    expect(h.calls).toHaveLength(1);
  });

  test("reads a combined (exo-merged) body from its own KV key and cites lines of the combined text", async () => {
    // The body shape combinedMeetingStore writes: per-segment `sources` and `alternate` ride along.
    const body = [
      { index: 0, speaker_name: "Avery", text: "We agreed to ship the combined meeting on Friday.", start_time: 5, end_time: 9,
        sources: [{ source: "fireflies", source_id: "ff-1", index: 0 }, { source: "google-meet", source_id: "gm-1", index: 3 }] },
      { index: 1, speaker_name: "Sam", text: "Budget review moves to Monday.", start_time: 12, end_time: 15,
        sources: [{ source: "google-meet", source_id: "gm-1", index: 4 }], alternate: { text: "Budget moves Monday" } },
    ];
    const h = evidenceHarness({
      kv: async () => ({ ok: true, data: { data: JSON.stringify(body) } }),
    });
    const selected = candidate({ source: "exo-merged", sourceId: "merged-1", hasLocalTranscript: true });

    const outcome = await readMeetingEvidence(selected, h.options as never);

    expect(h.calls).toEqual([`kv:${transcriptKvKey("exo-merged", "merged-1")}`]);
    expect(outcome.status).toBe("evidence");
    if (outcome.status !== "evidence") return;
    expect(outcome.evidence.transcriptLocator).toEqual({ kind: "local-kv-transcript", source: "exo-merged", sourceId: "merged-1" });
    const cited = rankMeetingExcerpts("when does the budget review move", outcome.evidence.transcriptChunks!);
    // The citation format is unchanged: position, speaker and time within the combined body.
    expect(cited.map((e) => e.citation)).toEqual(expect.arrayContaining([expect.stringMatching(/^\[M1:E\d+, (Avery|Sam), 00:00:\d\d\]$/)]));
    expect(cited.some((e) => e.text.includes("Budget review moves to Monday"))).toBe(true);
  });

  test("parses the exported reconciled V1 record only after selection", async () => {
    const h = evidenceHarness({
      kv: async () => ({
        ok: true,
        data: {
          data: JSON.stringify({
            v: 1,
            source: "fireflies",
            sourceId: "meeting-1",
            hasSummary: true,
            hasTranscript: false,
            summary: { overview: "Local reconcile summary", action_items: "Confirm launch." },
          }),
        },
      }),
    });

    expect(await readMeetingEvidence(candidate({ hasLocalRecord: true }), h.options as never)).toEqual({
      status: "evidence",
      evidence: expect.objectContaining({
        summary: "Overview:\nLocal reconcile summary\n\nAction items:\nConfirm launch.",
        summaryLocator: { kind: "local-kv-record", source: "fireflies", sourceId: "meeting-1" },
        reads: 1,
      }),
    });
    expect(h.calls).toEqual([expect.stringContaining("/meeting/meeting-1")]);
  });

  test("keeps missing/malformed selected content distinct from a critical storage failure", async () => {
    const stale = evidenceHarness({
      kv: async () => ({ ok: true, data: { data: "not json" } }),
    });
    const staleOutcome = await readMeetingEvidence(candidate({ hasLocalRecord: true }), stale.options as never);
    expect(staleOutcome).toEqual({ status: "no-content", partial: true, summaryAvailable: false });

    const broken = evidenceHarness({
      kv: async () => ({ ok: false, error: { code: "AUTH_UNAUTHORIZED" } }),
    });
    const brokenOutcome = await readMeetingEvidence(candidate({ hasLocalRecord: true }), broken.options as never);
    expect(brokenOutcome).toEqual({ status: "storage-error", partial: true });
  });

  test("returns deterministic no-content when no transcript is readable", async () => {
    const empty = evidenceHarness({ kv: async () => ({ ok: true, data: { data: "[]" } }) });
    expect(await readMeetingEvidence(candidate({ hasLocalTranscript: true }), empty.options as never)).toEqual({
      status: "no-content", partial: false, summaryAvailable: false,
    });
  });

  test("distinguishes a stale advertised SQL row from a valid-empty SQL row", async () => {
    const stale = evidenceHarness({ sql: async () => ({ ok: true, data: { rows: [] } }) });
    expect(await readMeetingEvidence(candidate({ hasSqlSummary: true, localRowId: "missing" }), stale.options as never)).toEqual({
      status: "no-content", partial: true, summaryAvailable: false,
    });
    const empty = evidenceHarness({ sql: async () => ({ ok: true, data: { rows: [[null, null]] } }) });
    expect(await readMeetingEvidence(candidate({ hasSqlSummary: true, localRowId: "empty" }), empty.options as never)).toEqual({
      status: "no-content", partial: false, summaryAvailable: false,
    });
  });

  test("reserves transcript reads after a SQL summary and reads the transcript", async () => {
    const h = evidenceHarness({
      sql: async () => ({ ok: true, data: { rows: [["Readable SQL summary", null]] } }),
      kv: async () => ({ ok: true, data: { data: JSON.stringify([{ speaker_name: "Avery", text: "Transcript evidence" }]) } }),
    });
    const selected = candidate({
      hasSqlSummary: true,
      localRowId: "local-1",
      hasLocalRecord: true,
      hasLocalTranscript: true,
    });

    expect(await readMeetingEvidence(selected, { ...(h.options as never), requireTranscript: true })).toEqual(
      expect.objectContaining({
        status: "evidence",
        evidence: expect.objectContaining({ summary: "Overview:\nReadable SQL summary", reads: 2 }),
      }),
    );
    expect(h.calls).toEqual([
      `sql:${SQL_MEETING_SUMMARY_QUERY}`,
      expect.stringContaining("/transcript/meeting-1"),
    ]);
  });

  test("reports abort without starting a read", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = evidenceHarness();
    expect(await readMeetingEvidence(candidate({ hasLocalRecord: true }), {
      ...(aborted.options as never),
      signal: controller.signal,
    })).toEqual({ status: "aborted" });
    expect(aborted.calls).toEqual([]);
  });

  test("returns aborted immediately after resolved SQL or KV failures and starts no later read", async () => {
    const sqlAbort = new AbortController();
    const sql = evidenceHarness({ sql: async () => {
      sqlAbort.abort();
      return { ok: false, data: { rows: [] } };
    } });
    expect(await readMeetingEvidence(candidate({ hasSqlSummary: true, localRowId: "row" }), {
      ...(sql.options as never), signal: sqlAbort.signal,
    })).toEqual({ status: "aborted" });
    expect(sql.calls).toEqual([`sql:${SQL_MEETING_SUMMARY_QUERY}`]);

    const kvAbort = new AbortController();
    const kv = evidenceHarness({ kv: async () => {
      kvAbort.abort();
      return { ok: false, error: { code: "AUTH_UNAUTHORIZED" } };
    } });
    expect(await readMeetingEvidence(candidate({ hasLocalRecord: true }), {
      ...(kv.options as never), signal: kvAbort.signal,
    })).toEqual({ status: "aborted" });
    expect(kv.calls).toHaveLength(1);
  });

  test("runs every evidence read serially and never exceeds the three-read cap", async () => {
    const h = evidenceHarness({
      sql: async () => ({ ok: true, data: { rows: [[null, null]] } }),
      kv: async () => ({ ok: false, error: { code: "KV_NOT_FOUND" } }),
    });
    const selected = candidate({
      hasSqlSummary: true,
      localRowId: "local-1",
      hasLocalRecord: true,
      hasLocalTranscript: true,
    });

    expect(await readMeetingEvidence(selected, h.options as never)).toEqual({ status: "no-content", partial: true, summaryAvailable: false });
    expect(h.calls).toEqual([
      `sql:${SQL_MEETING_SUMMARY_QUERY}`,
      expect.stringContaining("/meeting/meeting-1"),
      expect.stringContaining("/transcript/meeting-1"),
    ]);
    expect(h.maximumActive).toBe(1);
  });
});
