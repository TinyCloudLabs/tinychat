import { afterEach, describe, expect, mock, test } from "bun:test";

import { createChatModelAdapter, type AdapterDeps } from './chatModelAdapter';
import { createTurnOutcomeStore, takePendingCompletion, takePendingReceipt } from "./pendingHandoff";
import { getToolActivity } from "../lib/toolActivityStore";
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

function oneUserMessage(question = "What did they decide in the latest meeting?") {
  return [{
    id: "user-1",
    role: "user" as const,
    content: [{ type: "text" as const, text: question }],
  }];
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
    selection: {
      beginActiveTurn: async (turnId: string) => ({
        tcw: {} as never,
        space: "space-1",
        threadId: "t1",
        activation: 1,
      signal: new AbortController().signal,
        model: "m1",
        turnId,
      }),
      waitForAppend: async () => {},
    confirmAppend: () => {},
    captureCancel: () => () => {},
    cancel: () => {},
    assertActive: () => {},
      setRunning: () => {},
    } as never,
    agentEnabledRef: ref(false) as never,
    turnOutcomes: createTurnOutcomeStore(),
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

describe("chatModelAdapter agent interruption", () => {
  afterEach(() => { globalThis.fetch = realFetch; });

  for (const failure of ["fetch", "read", "eof", "turn_timeout"]) {
    test(`${failure} yields status only, preserves text, and skips success handoff without replay`, async () => {
      const messageId = `interrupted-${failure}`;
      const running: boolean[] = [];
      let requests = 0;
      let reads = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        if (failure === "fetch") throw new TypeError("PRIVATE FETCH SENTINEL");
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (reads++ === 0) {
              controller.enqueue(new TextEncoder().encode(
                'data: {"tool_activity":{"name":"web_search","status":"running"}}\n\n' +
                'data: {"id":"completion-1","choices":[{"delta":{"content":"Partial."}}]}\n\n' +
                'data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
              ));
            } else if (failure === "read") controller.error(new TypeError("PRIVATE READ SENTINEL"));
            else {
              if (failure === "turn_timeout") controller.enqueue(new TextEncoder().encode(
                'data: {"stream_error":{"code":"turn_timeout"},"choices":[{"delta":{"content":"legacy notice"}}]}\n\ndata: [DONE]\n\n',
              ));
              controller.close();
            }
          },
        }));
      }) as typeof fetch;
      const { deps } = makeDeps({ agentEnabledRef: ref(true), contextTokensFor: () => 64_000 });
      deps.selection.setRunning = (_origin, value) => { running.push(value); };
      const updates: unknown[] = [];
      let thrown: unknown;
      try {
        for await (const update of createChatModelAdapter(deps).run({
          messages: oneUserMessage(), context: {}, abortSignal: new AbortController().signal,
          unstable_assistantMessageId: messageId,
        } as never) as AsyncIterable<unknown>) updates.push(update);
      } catch (error) { thrown = error; }
      expect(thrown).toBeUndefined();
      expect(updates.map(({ metadata, ...rest }: any) => rest)).toEqual([
        ...(failure === "fetch" ? [] : [{ content: [{ type: "text", text: "Partial." }] }]),
        { status: { type: "incomplete", reason: "error", error: failure === "turn_timeout"
          ? "This reply took too long to finish. You can try again."
          : "The connection ended before the reply finished. You can try again." } },
      ]);
      expect((updates.at(-1) as any).metadata.custom.turn.status).toBe('failed');
      expect(requests).toBe(1);
      expect(takePendingCompletion(messageId)).toBeNull();
      expect(takePendingReceipt(messageId)).toBeNull();
      expect(getToolActivity(messageId)).toBeNull();
      expect(running).toEqual([true, false]);
    });
  }
});
