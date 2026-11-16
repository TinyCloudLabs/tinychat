// Tests for the C1 adapter branch (plain relay vs agent path) and C2 roomId
// threading. Uses createChatModelAdapter from chatModelAdapter.ts (extracted from
// runtime.tsx so it can be tested without the @assistant-ui/react DOM dependency).
//
// Strategy: mock globalThis.fetch to capture which URL was called; the routing
// decision is determined by deps.agentEnabledRef.current at run() invocation time.

import { afterEach, describe, expect, it } from "bun:test";
import { createChatModelAdapter, type AdapterDeps } from "./chatModelAdapter.js";
import { createAgentAccessController } from "./useAgentEnablement.js";
import { createMeetingMessageRegistry, takePendingReceipt, takePendingCompletion } from "./pendingHandoff.js";
import { DEFAULT_MODEL } from "../lib/threadStore.js";
import { clearGatewayReceipt, getGatewayReceiptVerified } from "../lib/gatewayReceiptStore";
import { offeredChatModelContextTokens } from "@tinyboilerplate/core";
import type { MeetingCandidate } from "../lib/meetingChat/types.js";

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

function makeDeps(agentEnabled: boolean, activeThreadId: string | null = null, model = DEFAULT_MODEL): AdapterDeps {
  const threadId = activeThreadId ?? "thread-without-active-ref";
  const selection = {
    getView: () => ({ threadId }),
    beginActiveTurn: async (turnId: string) => ({
      tcw: {} as never,
      space: "space-1",
      threadId,
      activation: 1,
      signal: new AbortController().signal,
      model,
      turnId,
    }),
    waitForAppend: async () => {},
    confirmAppend: () => {},
    captureCancel: () => () => {},
    cancel: () => {},
    assertActive: () => {},
    setRunning: () => {},
  } as never;
  return {
    backendUrl: "https://api.test",
    sessionStore: {
      getToken: () => "test-token",
      isExpired: () => false,
      hasSession: () => true,
    } as AdapterDeps["sessionStore"],
    selection,
    agentEnabledRef: { current: agentEnabled },
    privateAccessRef: { current: { active: true, revision: "test-revision", generation: 0 } },
    meetingMessageRegistry: createMeetingMessageRegistry(),
  };
}

function meetingCandidate(): MeetingCandidate {
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
  };
}

async function drainAdapter(
  deps: AdapterDeps,
  msgId = "msg-test",
  history: Parameters<ReturnType<typeof createChatModelAdapter>["run"]>[0]["messages"] = [],
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
    messages: [...history, { id: "user-turn", role: "user", content: [{ type: "text", text: "hi" }] }] as Parameters<typeof adapter.run>[0]["messages"],
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
  it("waits when the restored-session first send precedes the access probe", async () => {
    let resolveProbe!: (response: Response) => void;
    const probeResponse = new Promise<Response>((resolve) => { resolveProbe = resolve; });
    let resolveChat!: (response: Response) => void;
    const chatResponse = new Promise<Response>((resolve) => { resolveChat = resolve; });
    let calledUrl = "";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/api/agent/session")) return probeResponse;
      calledUrl = requestUrl;
      return chatResponse;
    }) as typeof fetch;

    const controller = createAgentAccessController({
      backendUrl: "https://api.test",
      tcw: { address: () => "0xone" } as never,
      sessionStore: { getToken: () => "test-token" } as never,
      appName: "test",
      openkeyHost: "https://openkey.test",
    });
    const deps = makeDeps(false);
    deps.agentEnabledRef = controller.agentEnabledRef as never;
    deps.privateAccessRef = controller.privateAccessRef;
    deps.waitForInitialProbe = controller.waitForInitialProbe;
    const adapter = createChatModelAdapter(deps);
    let thrown: unknown;
    const received: string[] = [];
    const sending = (async () => {
      try {
        for await (const frame of adapter.run({
          messages: [{ id: "restored-first", role: "user", content: [{ type: "text", text: "hi" }] }],
          abortSignal: new AbortController().signal,
          context: {},
          unstable_assistantMessageId: "restored-first",
        } as never)) {
          received.push(...frame.content.map((part) => part.type === "text" ? part.text : ""));
        }
      } catch (error) {
        thrown = error;
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 0));
    const requestBeforeProbeSettled = calledUrl;
    const probe = controller.refresh();
    resolveProbe(Response.json({ status: "active", transcriptStatus: "active", revision: "restored-r1" }));
    await probe;
    resolveChat(sseResponse(calledUrl));
    await sending;
    controller.dispose();

    expect(requestBeforeProbeSettled).toBe("");
    expect(calledUrl).toBe("https://api.test/api/agent/chat");
    expect(received.join("")).toBe("Hello");
    expect(thrown).toBeUndefined();
  });

  it("routes a transcript turn through /api/agent/chat without invoking the browser retriever", async () => {
    globalThis.fetch = (async (url: string) => sseResponse(url)) as typeof fetch;
    const deps = makeDeps(true, "thread-x");
    let browserReads = 0;
    deps.meetingRetriever = {
      retrieve: async () => {
        browserReads += 1;
        return {
          status: "grounded",
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
          systemMessage: "UNTRUSTED MEETING EVIDENCE",
          partial: false,
        };
      },
    } as AdapterDeps["meetingRetriever"];

    const { calledUrl } = await drainAdapter(deps);
    expect(browserReads).toBe(0);
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

  it("forwards streamed delegation failures to the reconnect controller", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{}}],"delegation_error":{"code":"delegation_expired"}}\n\n',
        ));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

    const errors: string[] = [];
    const deps = makeDeps(true);
    deps.onAgentDelegationError = (code) => errors.push(code);
    await drainAdapter(deps);

    expect(errors).toEqual(["delegation_expired"]);
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

  it("always binds roomId to the captured turn even without an active-thread ref", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("agent")) {
        body = JSON.parse((init?.body as string) ?? "{}");
      }
      return sseResponse(String(url));
    }) as typeof fetch;

    await drainAdapter(makeDeps(true, null));
    expect(body.roomId).toBe("thread-without-active-ref");
  });
});

describe("createChatModelAdapter — immutable turn model", () => {
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

  it("uses the captured model on both transport paths", async () => {
    const deps = makeDeps(true, "thread-x");
    expect((await captureBody(deps, true)).model).toBe(DEFAULT_MODEL);
    expect((await captureBody(makeDeps(false, "thread-x"), false)).model).toBe(DEFAULT_MODEL);
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

describe("createChatModelAdapter — streamed gateway receipt state", () => {
  const warning = "Couldn't confirm this reply came through the verified enclave. Don't rely on it.";

  for (const outcome of ["failed", "timed out"] as const) {
    it(`keeps the reply unverified after a ${outcome} audit`, async () => {
      const msgId = `msg-receipt-${outcome.replaceAll(" ", "-")}`;
      clearGatewayReceipt(msgId);
      globalThis.fetch = (async () => new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: `Partial reply. ${warning}` } }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;

      const result = await drainAdapter(makeDeps(false), msgId);
      expect(result.chunks.at(-1)).toContain(warning);
      expect(getGatewayReceiptVerified(msgId)).toBe(false);
      clearGatewayReceipt(msgId);
    });
  }

  it("marks the adapter reply verified only after the backend verifier event", async () => {
    const msgId = "msg-receipt-verified";
    clearGatewayReceipt(msgId);
    globalThis.fetch = (async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Verified reply." } }] })}\n\n`,
      'event: tinycloud.receipt-verification\ndata: {"status":"verified"}\n\n',
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;

    await drainAdapter(makeDeps(false), msgId);
    expect(getGatewayReceiptVerified(msgId)).toBe(true);
    clearGatewayReceipt(msgId);
  });
});

describe("turn binding across awaited work", () => {
  it("a delayed checkpoint keeps Qwen 35B's context budget, both transports and receipts on their captured model and room", async () => {
    const turnModel = "qwen/qwen3.6-35b-a3b";
    for (const agent of [false, true]) {
      const deps = makeDeps(agent, "origin-room", turnModel);
      let release!: () => void;
      let entered!: () => void;
      const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      deps.getCheckpoint = async () => { entered(); await held; return null; };
      deps.contextTokensFor = (model) => {
        expect(model).toBe(turnModel);
        const contextTokens = offeredChatModelContextTokens(model);
        expect(contextTokens).toBe(262_144);
        return contextTokens!;
      };
      deps.appendCompaction = async () => { throw new Error("unexpected compaction"); };
      deps.summarize = async () => { throw new Error("unexpected summary"); };
      const bodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (url, init) => { bodies.push(JSON.parse(init!.body as string)); return sseResponse(String(url)); }) as typeof fetch;
      // A prior exchange: a thread's first turn has no checkpoint to read.
      const prior = [
        { id: "prior-user", role: "user", content: [{ type: "text", text: "earlier" }] },
        { id: "prior-assistant", role: "assistant", content: [{ type: "text", text: "earlier reply" }] },
      ] as never;
      const running = drainAdapter(deps, `delayed-${agent}`, prior);
      await enteredGate;
      deps.agentEnabledRef.current = !agent;
      release();
      const result = await running;
      expect(result.calledUrl.includes("/api/agent/chat")).toBe(agent);
      expect(bodies[0].model).toBe(turnModel);
      if (agent) expect(bodies[0].roomId).toBe("origin-room");
      expect(takePendingReceipt(`delayed-${agent}`)?.modelId).toBe(turnModel);
    }
  });
});
