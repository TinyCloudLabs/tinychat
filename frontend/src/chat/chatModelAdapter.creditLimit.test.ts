import { afterEach, describe, expect, test } from "bun:test";

import { createChatModelAdapter, type AdapterDeps } from "./chatModelAdapter";
import { createMeetingMessageRegistry } from "./pendingHandoff";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const PARTIAL_COPY = "You've reached today's credit limit, so this reply stopped early. What's below is what was produced before the limit.";

function makeDeps(overrides: Partial<AdapterDeps> = {}): AdapterDeps {
  return {
    sessionStore: { getToken: () => "token", isExpired: () => false, clear: () => {} } as never,
    backendUrl: "http://backend.test",
    selection: {
      beginActiveTurn: async (turnId: string) => ({
        tcw: {} as never, space: "space-1", threadId: "t1", activation: 1,
        signal: new AbortController().signal, model: "m1", turnId,
      }),
      waitForAppend: async () => {},
      confirmAppend: () => {},
      captureCancel: () => () => {},
      cancel: () => {},
      assertActive: () => {},
      setRunning: () => {},
    } as never,
    agentEnabledRef: { current: true } as never,
    privateAccessRef: { current: { active: true, revision: "test-revision", generation: 0 } },
    meetingMessageRegistry: createMeetingMessageRegistry(),
    getCheckpoint: async () => null,
    appendCompaction: (async () => { throw new Error("unused"); }) as never,
    summarize: (async () => "") as never,
    contextTokensFor: () => 64_000,
    ...overrides,
  };
}

async function runTurn(sse: string, deps: AdapterDeps): Promise<unknown[]> {
  globalThis.fetch = (async () => new Response(sse, {
    status: 200, headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;
  const updates: unknown[] = [];
  for await (const update of createChatModelAdapter(deps).run({
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "Hello" }] }],
    context: {}, abortSignal: new AbortController().signal, unstable_assistantMessageId: "a1",
  } as never) as AsyncIterable<unknown>) updates.push(update);
  return updates;
}

const LIMIT = 'data: {"stream_error":{"code":"budget_exhausted"}}\n\ndata: [DONE]\n\n';

describe("agent turn stopped by the credit limit", () => {
  test("an empty reply says what happened with the plan name and reset time", async () => {
    const resetsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const updates = await runTurn(LIMIT, makeDeps({ getCreditLimitContext: () => ({ tierName: "Free", resetsAt }) }));
    expect(updates).toHaveLength(1);
    const error = (updates[0] as { status: { error: string } }).status.error;
    expect(error).toStartWith("You're out of credits on the Free plan, so this message got no reply. Credits reset ");
    expect(error).toEndWith(" UTC.");
  });

  test("an empty reply names your plan when no billing data is available", async () => {
    const updates = await runTurn(LIMIT, makeDeps());
    expect(updates).toEqual([{ status: { type: "incomplete", reason: "error", error:
      "You're out of credits on your plan, so this message got no reply." } }]);
  });

  test("a partial reply keeps the existing text", async () => {
    const sse = 'data: {"id":"c1","choices":[{"delta":{"content":"Partial."}}]}\n\n' + LIMIT;
    const updates = await runTurn(sse, makeDeps({ getCreditLimitContext: () => ({ tierName: "Free", resetsAt: null }) }));
    expect(updates).toEqual([
      { content: [{ type: "text", text: "Partial." }] },
      { status: { type: "incomplete", reason: "error", error: PARTIAL_COPY } },
    ]);
  });
});
