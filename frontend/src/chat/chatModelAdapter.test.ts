import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  CONTEXT_OVERFLOW_MESSAGE,
  createChatModelAdapter,
  type AdapterDeps,
} from "./chatModelAdapter";
import type { CompactionCheckpoint } from "./compaction";

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
