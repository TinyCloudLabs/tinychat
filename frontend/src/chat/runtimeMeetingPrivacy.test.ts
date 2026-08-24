import { afterEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { createChatModelAdapter, type AdapterDeps } from "./chatModelAdapter";
import { createMeetingMessageRegistry } from "./pendingHandoff";
import { getToolActivity } from "../lib/toolActivityStore";

const CANARY = "MEETING_TRANSCRIPT_PRIVACY_CANARY";
const initialHTMLElement = globalThis.HTMLElement;
const hadInitialHTMLElement = Object.hasOwn(globalThis, "HTMLElement");
const initialCustomElements = globalThis.customElements;
const hadInitialCustomElements = Object.hasOwn(globalThis, "customElements");

afterEach(() => {
  if (hadInitialHTMLElement) globalThis.HTMLElement = initialHTMLElement;
  else delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  if (hadInitialCustomElements) globalThis.customElements = initialCustomElements;
  else delete (globalThis as { customElements?: CustomElementRegistry }).customElements;
});

function historyTcw(captured: unknown[][]): TinyCloudWeb {
  const db = {
    async query() {
      return { ok: true, data: { rows: [] } };
    },
    async execute() {
      return { ok: true, data: { rows: [] } };
    },
    async batch(operations: unknown[]) {
      captured.push(operations);
      return { ok: true, data: { rows: [] } };
    },
  };
  return {
    did: `did:test:meeting-privacy-${Math.random()}`,
    sql: { db: () => db },
  } as unknown as TinyCloudWeb;
}

function sseResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Grounded answer [M1]"}}]}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("meeting-turn runtime privacy boundary", () => {
  test("keeps the canary only on the wire and suppresses runtime extraction across append retry", async () => {
    // runtime.tsx normally loads in the browser. Supply the tiny DOM surface
    // pulled in by the SDK before importing its pure history-adapter export.
    (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement ??= class {} as never;
    (globalThis as { customElements?: CustomElementRegistry }).customElements ??= {
      define: () => {},
      get: () => undefined,
      getName: () => undefined,
      upgrade: () => {},
      whenDefined: async () => undefined,
    } as never;
    const { createHistoryAdapter } = await import("./runtime");
    const sqlBatches: unknown[][] = [];
    const onAssistantTurnCalls: unknown[] = [];
    const logs: unknown[] = [];
    const tcw = historyTcw(sqlBatches);
    const meetingMessageRegistry = createMeetingMessageRegistry();
    const history = createHistoryAdapter(tcw, "meeting-thread", (exchange, turn) => {
      onAssistantTurnCalls.push({ exchange, turn });
    }, undefined, meetingMessageRegistry);
    const item = {
      message: {
        id: "meeting-assistant",
        role: "assistant",
        content: [{ type: "text", text: "Grounded answer [M1:E1, Avery, 00:00:03]" }],
      },
    } as never;

    // The retrieval/transport boundary owns this canary. It must be present
    // only in the one plain-chat payload and absent from history writes,
    // checkpoints/compaction inputs, memory/extraction, logs, tool activity,
    // source metadata, and provenance.
    const meetingContext = `<meeting-evidence>${CANARY}</meeting-evidence>`;
    const payloads: unknown[] = [];
    const compactionInputs: unknown[] = [];
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { logs.push(args); };
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body ?? "{}")));
      return sseResponse();
    }) as typeof fetch;
    try {
      const chat = createChatModelAdapter({
        backendUrl: "https://api.test",
        sessionStore: { getToken: () => "token", isExpired: () => false } as never,
        modelRef: { current: "model" } as never,
        offeredModelIdsRef: { current: new Set(["model"]) } as never,
        activeThreadIdRef: { current: "meeting-thread" } as never,
        agentEnabledRef: { current: true } as never,
        meetingRetriever: {
          retrieve: async () => ({
            status: "grounded",
            meeting: {
              source: "fireflies", sourceId: "m1", title: "Planning", startedAt: "2026-08-24T00:00:00.000Z",
              participantNames: [], participantEmails: [], organizerEmail: null,
              hasSqlSummary: false, hasLocalRecord: false, hasLocalTranscript: true,
              hasServerSummary: false, hasServerTranscript: false, localRowId: null, createdAt: null, updatedAt: null,
            },
            evidence: { summary: null, summaryLocator: null, transcript: null, transcriptLocator: null, reads: 1, partial: false, unavailableLocators: [] },
            systemMessage: meetingContext,
            partial: false,
          }),
        },
        meetingMessageRegistry,
        getCheckpoint: async () => null,
        summarize: async ({ messages }) => {
          compactionInputs.push(messages);
          return "compacted ordinary chat";
        },
        appendCompaction: async (_threadId, _through, summary) => {
          compactionInputs.push(summary);
          return { id: "checkpoint", threadId: "meeting-thread", coversThroughMessageId: "user", summary, createdAt: "2026-08-24T00:00:00.000Z" };
        },
        contextTokensFor: () => 64,
      } as AdapterDeps);
      for await (const _frame of chat.run({
        messages: [
          { id: "u0", role: "user", content: [{ type: "text", text: "ordinary history " + "x".repeat(600) }] },
          { id: "a0", role: "assistant", content: [{ type: "text", text: "ordinary reply " + "x".repeat(600) }] },
          { id: "u1", role: "user", content: [{ type: "text", text: "ordinary follow-up " + "x".repeat(600) }] },
          { id: "a1", role: "assistant", content: [{ type: "text", text: "ordinary reply " + "x".repeat(600) }] },
          { id: "user", role: "user", content: [{ type: "text", text: "latest meeting notes " + "x".repeat(600) }] },
        ],
        context: {},
        abortSignal: new AbortController().signal,
        unstable_assistantMessageId: "meeting-assistant",
      } as never)) {
        // Drain the stream so the handoff reaches the history boundary.
      }
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
    expect(JSON.stringify(payloads)).toContain(CANARY);
    expect(compactionInputs.length).toBeGreaterThan(0);
    expect(JSON.stringify(compactionInputs)).not.toContain(CANARY);
    expect(meetingMessageRegistry.isClassified("meeting-thread", "meeting-assistant")).toBe(true);

    await history.append(item);
    expect(meetingMessageRegistry.isClassified("meeting-thread", "meeting-assistant")).toBe(true);
    expect(onAssistantTurnCalls).toEqual([]);
    expect(JSON.stringify(sqlBatches)).not.toContain("meeting-assistant");

    // assistant-ui retains the visible reply after append. A genuine later
    // ordinary turn must filter it before both plain and agent payloads.
    const secondTurnPayloads: unknown[] = [];
    const secondFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      secondTurnPayloads.push(JSON.parse(String(init?.body ?? "{}")));
      return sseResponse();
    }) as typeof fetch;
    try {
      for (const agentEnabled of [false, true]) {
        const ordinary = createChatModelAdapter({
          backendUrl: "https://api.test",
          sessionStore: { getToken: () => "token", isExpired: () => false } as never,
          modelRef: { current: "model" } as never,
          offeredModelIdsRef: { current: new Set(["model"]) } as never,
          activeThreadIdRef: { current: "meeting-thread" } as never,
          agentEnabledRef: { current: agentEnabled } as never,
          meetingRetriever: { retrieve: async () => ({ status: "not-applicable" as const }) },
          meetingMessageRegistry,
          getCheckpoint: async () => null,
          summarize: async () => "summary",
          appendCompaction: async () => { throw new Error("no compaction expected"); },
          contextTokensFor: () => 100_000,
        });
        for await (const _frame of ordinary.run({
          messages: [
            { id: "meeting-assistant", role: "assistant", content: [{ type: "text", text: "GROUNDED_REPLY_SECOND_TURN_CANARY [M1:E1, Alice, 00:00:01]" }] },
            { id: `ordinary-user-${agentEnabled}`, role: "user", content: [{ type: "text", text: "ordinary question" }] },
          ],
          context: {}, abortSignal: new AbortController().signal,
          unstable_assistantMessageId: `ordinary-assistant-${agentEnabled}`,
        } as never)) { /* drain */ }
      }
    } finally {
      globalThis.fetch = secondFetch;
    }
    expect(secondTurnPayloads).toHaveLength(2);
    expect(JSON.stringify(secondTurnPayloads)).not.toContain("GROUNDED_REPLY_SECOND_TURN_CANARY");

    // Deterministic meeting outcomes take no inference path, but their later
    // assistant append carries the exact same privacy classification.
    let deterministicFetches = 0;
    const fetchBeforeDeterministic = globalThis.fetch;
    globalThis.fetch = (async () => {
      deterministicFetches += 1;
      return sseResponse();
    }) as typeof fetch;
    try {
      const deterministic = createChatModelAdapter({
        backendUrl: "https://api.test",
        sessionStore: { getToken: () => "token", isExpired: () => false } as never,
        modelRef: { current: "model" } as never,
        offeredModelIdsRef: { current: new Set(["model"]) } as never,
        activeThreadIdRef: { current: "meeting-thread" } as never,
        agentEnabledRef: { current: true } as never,
        meetingRetriever: { retrieve: async () => ({
          status: "no-content" as const,
          meeting: {
            source: "fireflies", sourceId: "m1", title: "Planning", startedAt: null,
            participantNames: [], participantEmails: [], organizerEmail: null,
            hasSqlSummary: false, hasLocalRecord: false, hasLocalTranscript: false,
            hasServerSummary: false, hasServerTranscript: false, localRowId: null, createdAt: null, updatedAt: null,
          },
          partial: false,
        }) },
        meetingMessageRegistry,
        getCheckpoint: async () => { throw new Error("deterministic outcomes must not compact"); },
        summarize: async () => { throw new Error("deterministic outcomes must not summarize"); },
        appendCompaction: async () => { throw new Error("deterministic outcomes must not checkpoint"); },
        contextTokensFor: () => 64,
      } as AdapterDeps);
      for await (const _frame of deterministic.run({
        messages: [{ id: "det-user", role: "user", content: [{ type: "text", text: "latest meeting notes" }] }],
        context: {}, abortSignal: new AbortController().signal,
        unstable_assistantMessageId: "deterministic-assistant",
      } as never)) {
        // Deterministic text is intentionally not sent to inference.
      }
    } finally {
      globalThis.fetch = fetchBeforeDeterministic;
    }
    expect(deterministicFetches).toBe(0);
    expect(meetingMessageRegistry.isClassified("meeting-thread", "deterministic-assistant")).toBe(true);
    await history.append({
      message: { id: "deterministic-assistant", role: "assistant", content: [{ type: "text", text: "No readable content." }] },
    } as never);
    expect(onAssistantTurnCalls).toEqual([]);
    expect(JSON.stringify(sqlBatches)).not.toContain(CANARY);
    expect(JSON.stringify(onAssistantTurnCalls)).not.toContain(CANARY);
    expect(JSON.stringify(logs)).not.toContain(CANARY);
    expect(getToolActivity("meeting-assistant")).toBeNull();
    expect(JSON.stringify(sqlBatches)).not.toContain("sourceId");
    expect(JSON.stringify(sqlBatches)).not.toContain("provenance");
  });
});
