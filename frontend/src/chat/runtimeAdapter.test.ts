// Tests for the C1 adapter branch (plain relay vs agent path) and C2 roomId
// threading. Uses createChatModelAdapter from chatModelAdapter.ts (extracted from
// runtime.tsx so it can be tested without the @assistant-ui/react DOM dependency).
//
// Strategy: mock globalThis.fetch to capture which URL was called; the routing
// decision is determined by deps.agentEnabledRef.current at run() invocation time.

import { afterEach, describe, expect, it } from "bun:test";
import { createChatModelAdapter, type AdapterDeps } from "./chatModelAdapter.js";
import { takePendingReceipt, takePendingCompletion } from "./pendingHandoff.js";
import { DEFAULT_MODEL } from "../lib/threadStore.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Minimal SSE response yielding one text chunk then [DONE].
function sseResponse(url: string, chunks: string[] = ["Hello"]): Response {
  const enc = new TextEncoder();
  const frames = [
    ...chunks.map((c) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: c } }], id: "cmpl-1" })}\n\n`,
    ),
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  void url;
}

function makeDeps(agentEnabled: boolean, activeThreadId: string | null = null): AdapterDeps {
  return {
    backendUrl: "https://api.test",
    sessionStore: {
      getToken: () => "test-token",
      isExpired: () => false,
      hasSession: () => true,
    } as AdapterDeps["sessionStore"],
    modelRef: { current: DEFAULT_MODEL },
    offeredModelIdsRef: { current: new Set() },
    agentEnabledRef: { current: agentEnabled },
    activeThreadIdRef: { current: activeThreadId },
  };
}

async function drainAdapter(
  deps: AdapterDeps,
  msgId = "msg-test",
): Promise<{ chunks: string[]; calledUrl: string }> {
  const adapter = createChatModelAdapter(deps);
  const chunks: string[] = [];
  let calledUrl = "";
  // Wrap fetch so we can capture the URL but still use the mock set by the caller.
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calledUrl = String(url);
    return origFetch(url as string, init);
  }) as typeof fetch;

  for await (const frame of adapter.run({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] as Parameters<typeof adapter.run>[0]["messages"],
    abortSignal: new AbortController().signal,
    context: {},
    unstable_assistantMessageId: msgId,
  })) {
    const part = (frame as { content?: Array<{ type: string; text?: string }> })
      .content?.[0];
    if (part?.type === "text" && part.text) chunks.push(part.text);
  }
  return { chunks, calledUrl };
}

describe("createChatModelAdapter — C1 branch selection", () => {
  it("calls /api/chat when agentEnabledRef is false", async () => {
    globalThis.fetch = (async (url: string) => sseResponse(url)) as typeof fetch;
    const { calledUrl } = await drainAdapter(makeDeps(false));
    expect(calledUrl).toContain("/api/chat");
    expect(calledUrl).not.toContain("/api/agent");
  });

  it("calls /api/agent/chat when agentEnabledRef is true", async () => {
    globalThis.fetch = (async (url: string) => sseResponse(url)) as typeof fetch;
    const { calledUrl } = await drainAdapter(makeDeps(true, "thread-x"));
    expect(calledUrl).toContain("/api/agent/chat");
  });

  it("yields cumulative text on the agent path", async () => {
    globalThis.fetch = (async (url: string) => sseResponse(url, ["Paris"])) as typeof fetch;
    const { chunks } = await drainAdapter(makeDeps(true));
    expect(chunks).toEqual(["Paris"]);
  });

  it("yields cumulative text on the plain relay path", async () => {
    globalThis.fetch = (async (url: string) => sseResponse(url, ["Paris"])) as typeof fetch;
    const { chunks } = await drainAdapter(makeDeps(false));
    expect(chunks).toEqual(["Paris"]);
  });
});

describe("createChatModelAdapter — C2 roomId threading", () => {
  it("passes activeThreadIdRef.current as roomId in the agent path body", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("agent")) {
        body = JSON.parse((init?.body as string) ?? "{}");
      }
      return sseResponse(String(url));
    }) as typeof fetch;

    await drainAdapter(makeDeps(true, "thread-room-42"));
    expect(body.roomId).toBe("thread-room-42");
  });

  it("omits roomId in agent path body when activeThreadIdRef is null", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("agent")) {
        body = JSON.parse((init?.body as string) ?? "{}");
      }
      return sseResponse(String(url));
    }) as typeof fetch;

    await drainAdapter(makeDeps(true, null));
    expect(body.roomId).toBeUndefined();
  });
});

describe("createChatModelAdapter — Bug #1 request-path model heal", () => {
  // A stale persisted id that was dropped from the lineup (not in the offered
  // membership set) must be sanitized to DEFAULT_MODEL before the request fires —
  // otherwise the backend 403s model_not_offered.
  const OFFERED = new Set([DEFAULT_MODEL, "qwen/qwen3.5-27b", "qwen/qwen-2.5-7b-instruct"]);

  function staleDeps(agentEnabled: boolean): AdapterDeps {
    const deps = makeDeps(agentEnabled, "thread-x");
    deps.modelRef = { current: "phala/gpt-oss-20b" };
    deps.offeredModelIdsRef = { current: OFFERED };
    return deps;
  }

  async function captureBody(deps: AdapterDeps, agentPath: boolean): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const match = agentPath ? String(url).includes("agent") : !String(url).includes("agent");
      if (match) body = JSON.parse((init?.body as string) ?? "{}");
      return sseResponse(String(url));
    }) as typeof fetch;
    await drainAdapter(deps);
    return body;
  }

  it("heals a stale unoffered model to DEFAULT_MODEL on the agent path", async () => {
    const body = await captureBody(staleDeps(true), true);
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.model).not.toBe("phala/gpt-oss-20b");
  });

  it("heals a stale unoffered model to DEFAULT_MODEL on the plain relay path", async () => {
    const body = await captureBody(staleDeps(false), false);
    expect(body.model).toBe(DEFAULT_MODEL);
  });

  it("leaves an offered model unchanged", async () => {
    const deps = makeDeps(true, "thread-x");
    deps.modelRef = { current: "qwen/qwen3.5-27b" };
    deps.offeredModelIdsRef = { current: OFFERED };
    const body = await captureBody(deps, true);
    expect(body.model).toBe("qwen/qwen3.5-27b");
  });
});

describe("createChatModelAdapter — C2 receipt+badge stashing on agent path", () => {
  it("stashes usage via setPendingReceipt on the agent path after stream completes", async () => {
    const msgId = "msg-stash-usage";
    globalThis.fetch = (async (url: string) => sseResponse(url)) as typeof fetch;
    await drainAdapter(makeDeps(true), msgId);
    const receipt = takePendingReceipt(msgId);
    expect(receipt).not.toBeNull();
    expect(receipt?.usage).toEqual({ promptTokens: 1, completionTokens: 1 });
    expect(receipt?.modelId).toBe(DEFAULT_MODEL);
  });

  it("stashes completionId via setPendingCompletion on the agent path after stream completes", async () => {
    const msgId = "msg-stash-completion";
    globalThis.fetch = (async (url: string) => sseResponse(url)) as typeof fetch;
    await drainAdapter(makeDeps(true), msgId);
    const completion = takePendingCompletion(msgId);
    expect(completion).not.toBeNull();
    expect(completion?.completionId).toBe("cmpl-1");
    expect(completion?.model).toBe(DEFAULT_MODEL);
  });

  it("stashes usage + completionId on the plain relay path via the shared post-branch block (no regression)", async () => {
    const msgId = "msg-relay-no-stash";
    globalThis.fetch = (async (url: string) => sseResponse(url)) as typeof fetch;
    await drainAdapter(makeDeps(false), msgId);
    // plain relay path also stashes via the same shared block — verify it works too
    const receipt = takePendingReceipt(msgId);
    expect(receipt).not.toBeNull();
    expect(receipt?.usage).toEqual({ promptTokens: 1, completionTokens: 1 });
  });
});
