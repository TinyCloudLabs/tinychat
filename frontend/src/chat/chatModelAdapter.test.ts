import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  CONTEXT_OVERFLOW_MESSAGE,
  MEETING_ABORTED_MESSAGE,
  MEETING_NO_CONTENT_MESSAGE,
  MEETING_NO_MATCH_MESSAGE,
  MEETING_STORAGE_ERROR_MESSAGE,
  clarificationDateToken,
  createChatModelAdapter,
  meetingOutcomeText,
  safeClarificationTitle,
  type AdapterDeps,
} from "./chatModelAdapter";
import { createMeetingMessageRegistry } from "./pendingHandoff";
import type { CompactionCheckpoint } from "./compaction";
import type { MeetingCandidate, MeetingRetrievalOutcome } from "../lib/meetingChat/types";

const realFetch = globalThis.fetch;

// Minimal React.MutableRefObject shim.
function ref<T>(current: T): { current: T } {
  return { current };
}

const sessionStore = {
  getToken: () => "token",
  isExpired: () => false,
  clear: () => {},
} as never;

// A short assistant-ui-style message list (each carries an id, so the planner
// can pick a coversThrough boundary).
function makeMessages(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: [{ type: "text" as const, text: `message number ${i} body text` }],
  }));
}

function oneUserMessage(question = "What did they decide in the latest meeting?") {
  return [{
    id: "user-1",
    role: "user" as const,
    content: [{ type: "text" as const, text: question }],
  }];
}

function meetingCandidate(patch: Partial<MeetingCandidate> = {}): MeetingCandidate {
  return {
    source: "fireflies",
    sourceId: "meeting-1",
    title: "Planning",
    startedAt: "2026-03-01T10:00:00.000Z",
    participantNames: [],
    participantEmails: [],
    organizerEmail: null,
    hasSqlSummary: false,
    hasLocalRecord: false,
    hasLocalTranscript: false,
    hasServerSummary: false,
    hasServerTranscript: false,
    localRowId: null,
    createdAt: null,
    updatedAt: null,
    ...patch,
  };
}

function makeDeps(overrides: Partial<AdapterDeps> = {}): {
  deps: AdapterDeps;
  summarize: ReturnType<typeof mock>;
  appendCompaction: ReturnType<typeof mock>;
} {
  const summarize = mock(async () => "COMPACTED SUMMARY");
  const appendCompaction = mock(
    async (threadId: string, coversThroughMessageId: string, summary: string): Promise<CompactionCheckpoint> => ({
      id: "cp-1",
      threadId,
      coversThroughMessageId,
      summary,
      createdAt: "2026-07-02T00:00:00.000Z",
    }),
  );
  const deps: AdapterDeps = {
    sessionStore,
    backendUrl: "http://backend.test",
    modelRef: ref("m1") as never,
    activeThreadIdRef: ref<string | null>("t1") as never,
    agentEnabledRef: ref(false) as never,
    offeredModelIdsRef: ref<ReadonlySet<string>>(new Set(["m1"])) as never,
    meetingMessageRegistry: createMeetingMessageRegistry(),
    getCheckpoint: async () => null,
    appendCompaction: appendCompaction as never,
    summarize: summarize as never,
    // Small window forces the proactive + reactive compaction passes to engage.
    contextTokensFor: () => 8,
    ...overrides,
  };
  return { deps, summarize, appendCompaction };
}

function overflowResponse(): Response {
  return new Response(
    JSON.stringify({ error: { code: "context_overflow", message: "too long" } }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}

function okStreamResponse(text: string): Response {
  const body =
    `data: {"id":"c1","choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function drain(gen: AsyncGenerator<{ content: { type: string; text: string }[] }>) {
  let text = "";
  let thrown: unknown;
  try {
    for await (const chunk of gen) {
      const part = chunk.content[0];
      if (part && part.type === "text") text = part.text;
    }
  } catch (err) {
    thrown = err;
  }
  return { text, thrown };
}

describe("chatModelAdapter reactive compaction", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("adapter_compacts_and_retries_once_on_overflow", async () => {
    // First transport call overflows; after a forced compaction the retry
    // succeeds. A subsequent run where BOTH attempts overflow surfaces the
    // friendly copy and does NOT retry a second time.

    // — Scenario A: overflow → compact → retry once → success. —
    const calls: string[] = [];
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      calls.push(`call${call}`);
      return call === 1 ? overflowResponse() : okStreamResponse("hello world");
    }) as typeof fetch;

    const { deps, summarize } = makeDeps();
    const adapter = createChatModelAdapter(deps);
    const resultA = await drain(
      adapter.run({
        messages: makeMessages(6),
        context: {},
        unstable_assistantMessageId: "a1",
      } as never) as never,
    );

    expect(resultA.thrown).toBeUndefined();
    expect(resultA.text).toBe("hello world");
    expect(call).toBe(2); // exactly one reactive retry
    expect(summarize.mock.calls.length).toBeGreaterThanOrEqual(1); // compaction ran

    // — Scenario B: both attempts overflow → friendly error, no third try. —
    let callB = 0;
    globalThis.fetch = (async () => {
      callB += 1;
      return overflowResponse();
    }) as typeof fetch;

    const { deps: depsB } = makeDeps();
    const adapterB = createChatModelAdapter(depsB);
    const resultB = await drain(
      adapterB.run({
        messages: makeMessages(6),
        context: {},
        unstable_assistantMessageId: "b1",
      } as never) as never,
    );

    expect(resultB.thrown).toBeInstanceOf(Error);
    expect((resultB.thrown as Error).message).toBe(CONTEXT_OVERFLOW_MESSAGE);
    expect(callB).toBe(2); // initial + exactly one retry, then give up (§F.8)
  });
});

describe("chatModelAdapter meeting retrieval preflight", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("calls the injected retriever once before checkpoint loading and sends grounded context after memory", async () => {
    const events: string[] = [];
    const retrieve = mock(async (input: { threadId: string; question: string; signal?: AbortSignal }) => {
      events.push("retrieve");
      expect(input).toEqual({
        threadId: "t1",
        question: "What did they decide in the latest meeting?",
        signal: expect.any(AbortSignal),
      });
      return {
        status: "grounded" as const,
        meeting: meetingCandidate(),
        evidence: {
          summary: "private evidence",
          summaryLocator: null,
          transcript: null,
          transcriptLocator: null,
          reads: 1,
          partial: false,
          unavailableLocators: [],
        },
        systemMessage: "MEETING SYSTEM EVIDENCE",
        partial: false,
      };
    });
    let url = "";
    let body: { messages?: Array<{ role: string; content: string }> } = {};
    globalThis.fetch = (async (requestUrl: string, init?: RequestInit) => {
      events.push("fetch");
      url = requestUrl;
      body = JSON.parse((init?.body as string) ?? "{}");
      return okStreamResponse("grounded reply");
    }) as typeof fetch;

    const { deps } = makeDeps({
      meetingRetriever: { retrieve } as never,
      contextTokensFor: () => 64_000,
      agentEnabledRef: ref(true) as never,
      getCheckpoint: async () => {
        events.push("checkpoint");
        return null;
      },
    });
    const result = await drain(
      createChatModelAdapter(deps).run({
        messages: oneUserMessage(),
        abortSignal: new AbortController().signal,
        context: { system: "USER MEMORY" },
        unstable_assistantMessageId: "assistant-1",
      } as never) as never,
    );

    expect(result).toEqual({ text: "grounded reply", thrown: undefined });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["retrieve", "checkpoint", "fetch"]);
    expect(url).toContain("/api/chat");
    expect(url).not.toContain("/api/agent/chat");
    expect(body.messages).toEqual([
      { role: "system", content: "USER MEMORY" },
      { role: "system", content: "MEETING SYSTEM EVIDENCE" },
      { role: "user", content: "What did they decide in the latest meeting?" },
    ]);
    expect(deps.meetingMessageRegistry.isClassified("t1", "assistant-1")).toBe(true);
  });

  test("counts meeting context as a fixed compaction block on proactive and reactive passes without summarizing it", async () => {
    const meetingContext = `MEETING-CANARY:${"x".repeat(15_000)}`;
    const payloads: Array<Array<{ role: string; content: string }>> = [];
    const urls: string[] = [];
    let calls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls += 1;
      urls.push(url);
      payloads.push(JSON.parse((init?.body as string) ?? "{}").messages);
      return calls === 1 ? overflowResponse() : okStreamResponse("retried reply");
    }) as typeof fetch;
    const retrieve = mock(async () => ({
      status: "grounded" as const,
      meeting: meetingCandidate(),
      evidence: {
        summary: null,
        summaryLocator: null,
        transcript: null,
        transcriptLocator: null,
        reads: 0,
        partial: false,
        unavailableLocators: [],
      },
      systemMessage: meetingContext,
      partial: false,
    }));
    const { deps, summarize } = makeDeps({
      meetingRetriever: { retrieve } as never,
      contextTokensFor: () => 5_000,
      agentEnabledRef: ref(true) as never,
    });

    const result = await drain(
      createChatModelAdapter(deps).run({
        messages: makeMessages(5),
        abortSignal: new AbortController().signal,
        context: { system: "USER MEMORY" },
        unstable_assistantMessageId: "meeting-compaction",
      } as never) as never,
    );

    expect(result).toEqual({ text: "retried reply", thrown: undefined });
    expect(retrieve).toHaveBeenCalledTimes(1);
    // The large meeting system block forces both the proactive pass and the
    // one reactive overflow retry. It is a fixed budget cost for each pass.
    expect(summarize).toHaveBeenCalledTimes(2);
    for (const call of summarize.mock.calls) {
      expect(JSON.stringify(call[0]?.messages)).not.toContain("MEETING-CANARY:");
    }
    expect(payloads).toHaveLength(2);
    expect(urls).toEqual(["http://backend.test/api/chat", "http://backend.test/api/chat"]);
    for (const payload of payloads) {
      expect(payload[0]).toEqual({ role: "system", content: "USER MEMORY" });
      expect(payload[1]).toEqual({ role: "system", content: meetingContext });
      expect(payload[2]).toEqual({
        role: "system",
        content: "<conversation_summary>\nCOMPACTED SUMMARY\n</conversation_summary>",
      });
    }
    expect(deps.meetingMessageRegistry.isClassified("t1", "meeting-compaction")).toBe(true);
  });

  const deterministicOutcomes: Array<{
    outcome: Exclude<MeetingRetrievalOutcome, { status: "not-applicable" } | { status: "grounded" }>;
    expected: string | ((text: string) => void);
  }> = [
    {
      outcome: { status: "clarification", choices: [meetingCandidate()] },
      expected: (text) => {
        expect(text).toStartWith("Choose the meeting to use. Reply with an option number:\n- 1. Planning — ");
        expect(text).toContain("[2026-03-01] (Fireflies)");
      },
    },
    { outcome: { status: "no-match", partial: false }, expected: MEETING_NO_MATCH_MESSAGE },
    { outcome: { status: "no-content", meeting: meetingCandidate(), partial: false }, expected: MEETING_NO_CONTENT_MESSAGE },
    { outcome: { status: "storage-error", partial: true }, expected: MEETING_STORAGE_ERROR_MESSAGE },
    { outcome: { status: "aborted" }, expected: MEETING_ABORTED_MESSAGE },
  ];

  for (const { outcome, expected } of deterministicOutcomes) {
    test(`streams ${outcome.status} without inference or compaction`, async () => {
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return okStreamResponse("must not run");
      }) as typeof fetch;
      const retrieve = mock(async () => outcome);
      const getCheckpoint = mock(async () => null);
      const { deps } = makeDeps({
        meetingRetriever: { retrieve } as never,
        getCheckpoint: getCheckpoint as never,
      });

      const result = await drain(
        createChatModelAdapter(deps).run({
          messages: oneUserMessage(),
          abortSignal: new AbortController().signal,
          context: {},
          unstable_assistantMessageId: `meeting-${outcome.status}`,
        } as never) as never,
      );

      expect(result.thrown).toBeUndefined();
      if (typeof expected === "string") expect(result.text).toBe(expected);
      else expected(result.text);
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(getCheckpoint).not.toHaveBeenCalled();
      expect(fetchCalls).toBe(0);
      expect(deps.meetingMessageRegistry.isClassified("t1", `meeting-${outcome.status}`)).toBe(true);
    });
  }

  test("renders hostile clarification metadata as one bounded, round-trippable line", () => {
    const hostile = "# fake choice\n[click](https://bad.test)\u0000 - " + "x".repeat(300);
    const title = safeClarificationTitle(hostile);
    expect(title).not.toContain("\r");
    expect(title).not.toContain("\n");
    expect(title).not.toContain("\u0000");
    expect(title).toContain("\\#");
    expect(title).toContain("\\[");
    expect(title.length).toBeLessThanOrEqual(320);
    expect(clarificationDateToken("not-a-date")).toBeNull();
    expect(clarificationDateToken("2026-03-01T10:00:00.000Z")).toBe("2026-03-01");
  });

  test("uses transcript-specific no-content copy only when a summary remains available", () => {
    expect(meetingOutcomeText({
      status: "no-content",
      meeting: meetingCandidate(),
      partial: false,
      summaryAvailable: true,
      transcriptRequired: true,
    })).toBe("I found a summary, but no readable transcript is available for that request.");
  });

  test("not-applicable preserves the ordinary inference path", async () => {
    const retrieve = mock(async () => ({ status: "not-applicable" as const }));
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return okStreamResponse("ordinary reply");
    }) as typeof fetch;
    const { deps } = makeDeps({
      meetingRetriever: { retrieve } as never,
      contextTokensFor: () => 64_000,
    });

    const result = await drain(
      createChatModelAdapter(deps).run({
        messages: oneUserMessage("hello"),
        abortSignal: new AbortController().signal,
        context: {},
        unstable_assistantMessageId: "ordinary-1",
      } as never) as never,
    );

    expect(result).toEqual({ text: "ordinary reply", thrown: undefined });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toBe(1);
    expect(deps.meetingMessageRegistry.isClassified("t1", "ordinary-1")).toBe(false);
  });
});
