/**
 * Adapter boundary proofs. Run beside the matching Eliza worktree:
 * bun test frontend/src/chat/elizaAdapter.integration.test.ts
 *
 * Both HTTP servers and their auth/stream handlers are real. The provider and
 * private storage reader are controlled; private tools use real Eliza actions.
 * React persistence is covered separately. A standalone checkout skips this joint gate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { offeredChatModelContextTokens } from "@tinyboilerplate/core";
import { createAuthMiddleware } from "../../../backend/src/middleware/auth.js";
import { createAgentRouter } from "../../../backend/src/routes/agent.js";
import { addressToEntityId, TINYCHAT_AGENT_ID } from "../../../backend/src/entity-id.js";
import { createChatModelAdapter, type AdapterDeps } from "./chatModelAdapter.js";
import { createMeetingMessageRegistry, takePendingCompletion, takePendingReceipt } from "./pendingHandoff.js";

const backendRequire = createRequire(new URL("../../../backend/package.json", import.meta.url));
const express = backendRequire("express") as typeof import("express");
const { createCsrfMiddleware, issueSessionToken } = backendRequire("@tinyboilerplate/server");

const elizaSource = new URL("../../../../tinycloud-agents/packages/eliza-service/src/", import.meta.url);
const MODEL = "moonshotai/kimi-k3";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const KEY = `0x${"02".repeat(32)}`;
const SERVICE_SECRET = "joint-adapter-test-only";
const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const finalProviderFrames = frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }) + "data: [DONE]\n\n";
const nativeFetch = globalThis.fetch;
const nativeConsole = { info: console.info, log: console.log, warn: console.warn, error: console.error };
const diagnosticLogs: unknown[][] = [];
let cleanup: Array<() => Promise<void>> = [];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  diagnosticLogs.length = 0;
  for (const method of Object.keys(nativeConsole) as Array<keyof typeof nativeConsole>) console[method] = (...args) => {
    diagnosticLogs.push(args.map(value => value instanceof Error ? { name: value.name, message: value.message } : value));
  };
  savedEnv = { PAYWALL_ENABLED: process.env.PAYWALL_ENABLED, ELIZA_SERVICE_SECRET: process.env.ELIZA_SERVICE_SECRET };
  process.env.PAYWALL_ENABLED = "false";
  process.env.ELIZA_SERVICE_SECRET = SERVICE_SECRET;
});
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup = [];
  globalThis.fetch = nativeFetch;
  Object.assign(console, nativeConsole);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Local boundary test timed out")), 2500); });
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer!); }
}

async function setup(provider: (input: string, init?: RequestInit) => Promise<Response>, taskFlag?: boolean,
  runtimeFor?: (agentId: string) => Promise<unknown>) {
  // Test-only sibling imports; no production module or package depends on Eliza.
  const { createElizaServiceFetch } = await import(new URL("server.ts", elizaSource).href);
  const { SessionStore } = await import(new URL("session-store.ts", elizaSource).href);
  const tasks: Array<Record<string, any>> = [];
  const providerRequests: Array<Record<string, any>> = [];
  const backendCalls: string[] = [];
  const privateStreams: Array<Promise<Array<Record<string, any>>>> = [];
  const browserStreams: Array<Promise<string>> = [];
  let reportTaskResponse!: (status: number) => void;
  const taskResponse = new Promise<number>(resolve => { reportTaskResponse = resolve; });
  let backendProviderCalls = 0;
  let nativeRuntimeCalls = 0;
  const forbiddenNativeRuntime = async () => { nativeRuntimeCalls++; throw new Error("Ordinary task attempted native runtime or memory"); };
  const elizaHandler = createElizaServiceFetch({
    host: { agentDid: "did:test:joint-local", runtimeFor: runtimeFor ?? forbiddenNativeRuntime, storageFor: forbiddenNativeRuntime, preflight: forbiddenNativeRuntime },
    sessions: new SessionStore(),
    tasks: {
      apiKey: "controlled-provider", baseUrl: "http://127.0.0.1/v1", models: { [MODEL]: offeredChatModelContextTokens(MODEL)! },
      fetchImpl: async (input: string, init?: RequestInit) => {
        providerRequests.push(JSON.parse(String(init?.body)));
        return provider(input, init);
      },
    },
  });
  const eliza = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/tasks") tasks.push(await request.clone().json());
      const response = await elizaHandler(request);
      if (path === "/tasks") reportTaskResponse(response.status);
      if (path === "/tasks" && response.ok) privateStreams.push(response.clone().text().then((body: string) => body.split("\n\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))));
      return response;
    },
  });
  cleanup.push(async () => { await eliza.stop(true); });
  const elizaUrl = `http://127.0.0.1:${eliza.port}`;
  const app = express();
  app.use(express.json());
  app.use(createCsrfMiddleware());
  app.use("/api/agent", createAgentRouter({
    agentDid: "did:test:joint-local", elizaServiceUrl: elizaUrl, elizaServiceSecret: SERVICE_SECRET,
    authMiddleware: createAuthMiddleware(KEY),
    chat: {
      agentId: TINYCHAT_AGENT_ID, entityIdFor: address => addressToEntityId(address, TINYCHAT_AGENT_ID),
      elizaServiceUrl: elizaUrl, elizaServiceSecret: SERVICE_SECRET,
      redpillApiKey: "controlled-legacy-provider", redpillBaseUrl: "http://127.0.0.1/legacy-provider/v1",
      defaultModel: () => MODEL, isModelOffered: model => model === MODEL,
      streamPolicy: { heartbeatMs: 100, turnTimeoutMs: 5000, drainGraceMs: 100 },
      ...(taskFlag === undefined ? {} : { elizaTasksEnabled: taskFlag }),
      fetchImpl: (async (input, init) => {
        const url = String(input);
        backendCalls.push(url);
        if (url.startsWith(`${elizaUrl}/`)) return nativeFetch(input, init);
        if (taskFlag !== true && url === "http://127.0.0.1/legacy-provider/v1/chat/completions") {
          backendProviderCalls++;
          return provider(url, init);
        }
        throw new Error("Task path attempted backend provider/tool work or external network");
      }) as typeof fetch,
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await bounded(new Promise<void>(resolve => server.once("listening", resolve)));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const backendUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = (await issueSessionToken(ADDRESS, KEY)).token;
  // Catch accidental ambient provider/catalog/storage requests. This wrapper
  // passes the actual browser response through unchanged and observes a clone.
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${backendUrl}/`)) throw new Error("Unexpected external network from frontend boundary test");
    const response = await nativeFetch(input, init);
    if (response.ok && response.headers.get("content-type")?.includes("text/event-stream")) browserStreams.push(response.clone().text());
    return response;
  }) as typeof fetch;

  function run(assistantId: string, question = "Say hello.") {
    const roomId = `room-${assistantId}`;
    const selection = {
      getView: () => ({ threadId: roomId }),
      beginActiveTurn: async (turnId: string) => ({ tcw: {} as never, space: "local-test-space", threadId: roomId, activation: 1, signal: new AbortController().signal, model: MODEL, turnId }),
      waitForAppend: async () => {}, confirmAppend: () => {}, captureCancel: () => () => {}, cancel: () => {}, assertActive: () => {}, setRunning: () => {},
    } as AdapterDeps["selection"];
    const adapter = createChatModelAdapter({
      backendUrl, selection,
      sessionStore: { getToken: () => token, isExpired: () => false, hasSession: () => true } as AdapterDeps["sessionStore"],
      agentEnabledRef: { current: true }, meetingMessageRegistry: createMeetingMessageRegistry(),
      getCheckpoint: async () => null,
      appendCompaction: async () => { throw new Error("Unexpected compaction write"); },
      summarize: async () => { throw new Error("Unexpected compaction inference"); },
      contextTokensFor: () => offeredChatModelContextTokens(MODEL)!,
    });
    return adapter.run({
      messages: [{ id: `user-${assistantId}`, role: "user", content: [{ type: "text", text: question }] }] as Parameters<typeof adapter.run>[0]["messages"],
      abortSignal: new AbortController().signal, context: { system: "Local controlled account context." }, unstable_assistantMessageId: assistantId,
    });
  }
  return { run, backendUrl, token, tasks, taskResponse, providerRequests, backendCalls, privateStreams, browserStreams, backendProviderCalls: () => backendProviderCalls, nativeRuntimeCalls: () => nativeRuntimeCalls };
}

function textOf(frame: unknown): string | undefined {
  return (frame as { content?: Array<{ type: string; text?: string }> }).content?.find(part => part.type === "text")?.text;
}

describe.skipIf(!existsSync(new URL("server.ts", elizaSource)))("adapter → authenticated backend → real Eliza HTTP boundary", () => {
  test("streams before provider completion, submits once, and hands off one complete usage/ID receipt", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let opened!: () => void;
    const providerOpened = new Promise<void>(resolve => { opened = resolve; });
    const app = await setup(async () => new Response(new ReadableStream({ start(controller) { stream = controller; opened(); } })), true);

    const body = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "Say hello." }] });
    expect((await fetch(`${app.backendUrl}/api/agent/chat`, { method: "POST", headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: "Bearer invalid" }, body })).status).toBe(401);
    expect((await fetch(`${app.backendUrl}/api/agent/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${app.token}` }, body })).status).toBe(403);
    expect(app.tasks).toHaveLength(0);

    const iterator = app.run("ordinary");
    const first = iterator.next();
    const taskStatus = await bounded(app.taskResponse);
    if (taskStatus !== 200) {
      await bounded(first);
      while (!(await bounded(iterator.next())).done) { /* Drain the rejected request before cleanup. */ }
    }
    expect(taskStatus).toBe(200);
    await bounded(providerOpened);
    stream.enqueue(encoder.encode(frame({ id: "provider-ordinary", choices: [{ delta: { content: "Hello" } }] })));
    expect(textOf((await bounded(first)).value)).toBe("Hello");
    expect(takePendingCompletion("ordinary")).toBeNull();
    stream.enqueue(encoder.encode(frame({ choices: [{ delta: { content: " world." } }] }) + finalProviderFrames));
    stream.close();
    const remaining: string[] = [];
    for (;;) { const next = await bounded(iterator.next()); if (next.done) break; const text = textOf(next.value); if (text) remaining.push(text); }
    expect(remaining.at(-1)).toBe("Hello world.");
    expect(app.tasks).toHaveLength(1);
    expect(app.tasks[0]).toMatchObject({ version: 1, entityId: addressToEntityId(ADDRESS, TINYCHAT_AGENT_ID), roomId: "room-ordinary", model: { id: MODEL } });
    expect(app.tasks[0].messages.some((message: { content: string }) => message.content.includes("Local controlled account context."))).toBe(true);
    expect(app.providerRequests).toHaveLength(1);
    expect(app.providerRequests[0]).toMatchObject({ model: MODEL, stream: true, stream_options: { include_usage: true } });
    expect(app.backendCalls.map(url => new URL(url).pathname)).toEqual(["/capabilities", "/tasks"]);
    expect(app.backendProviderCalls()).toBe(0);
    expect(app.nativeRuntimeCalls()).toBe(0);
    expect(takePendingReceipt("ordinary")).toEqual({ usage: { promptTokens: 12, completionTokens: 3 }, modelId: MODEL });
    expect(takePendingCompletion("ordinary")).toEqual({ completionId: "provider-ordinary", model: MODEL });
    const privateEvents = await bounded(app.privateStreams[0]);
    expect(privateEvents.filter(event => event.type === "final")).toHaveLength(1);
    expect(privateEvents.at(-1)).toMatchObject({ type: "final", outcome: "success", promptTokens: 12, completionTokens: 3, usageCompleteness: "complete" });
    const browser = await bounded(app.browserStreams[0]);
    expect(browser.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(browser.match(/"prompt_tokens":12/g)).toHaveLength(1);
    expect(browser.match(/"content":"Hello"/g)).toHaveLength(1);
    expect(browser).not.toContain(app.tasks[0].executionId);
  });

  test("early prose followed by forbidden tool work never creates a success badge or replay", async () => {
    const app = await setup(async () => new Response(
      frame({ id: "not-a-final-answer", choices: [{ delta: { content: "Checking." } }] }) +
      frame({ usage: { prompt_tokens: 12, completion_tokens: 3 }, choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "RUN_ARTIFACT_SKILL", arguments: "{}" } }] } }] }) + finalProviderFrames,
    ), true);
    const chunks: string[] = [];
    for await (const event of app.run("unsupported-tool")) { const text = textOf(event); if (text) chunks.push(text); }
    expect(await bounded(app.taskResponse)).toBe(200);
    expect(chunks[0]).toBe("Checking.");
    expect(app.tasks).toHaveLength(1);
    expect(app.providerRequests).toHaveLength(1);
    expect(app.backendProviderCalls()).toBe(0);
    expect(takePendingCompletion("unsupported-tool")).toBeNull();
    expect(takePendingReceipt("unsupported-tool")).toBeNull();
    expect((await bounded(app.privateStreams[0])).at(-1)).toMatchObject({ outcome: "failed", answerIsProviderVerbatim: false, promptTokens: 12, completionTokens: 3 });
    const browser = await bounded(app.browserStreams[0]);
    expect(browser).toContain('"stream_error"');
    expect(browser).not.toContain("not-a-final-answer");
  });

  test("an omitted task flag preserves the legacy route and makes no Eliza task submission", async () => {
    const app = await setup(async () => new Response(frame({ id: "legacy-answer", choices: [{ delta: { content: "Legacy hello." } }] }) + finalProviderFrames));
    const chunks: string[] = [];
    for await (const event of app.run("flag-omitted")) { const text = textOf(event); if (text) chunks.push(text); }
    expect(chunks.at(-1)).toBe("Legacy hello.");
    expect(app.tasks).toHaveLength(0);
    expect(app.providerRequests).toHaveLength(0);
    expect(app.backendProviderCalls()).toBe(1);
    expect(takePendingCompletion("flag-omitted")?.completionId).toBe("legacy-answer");
  });

  test("one task owns discovery, sequential private reads and buffered cited synthesis through the actual adapter", async () => {
    const { tinycloudFindMeetingsAction, tinycloudReadMeetingAction, setTranscriptRegistry } = await import(new URL("actions/tinycloud-search-transcripts.ts", elizaSource).href);
    const rawCanary = "JOINT_SYNTHETIC_RAW_EVIDENCE_CANARY";
    const discoveryDraft = "JOINT_PRIVATE_DISCOVERY_DRAFT";
    const readDraft = "JOINT_PRIVATE_READ_DRAFT";
    const records = ["one", "two"].map((id, index) => ({
      meetingRef: `joint-${id}`, source: "fireflies", sourceId: id, title: `Controlled meeting ${index + 1}`,
      startedAt: `2026-09-0${8 + index}T10:00:00Z`, participantNames: [], participantEmails: [], organizerEmail: null,
      summaryOverview: null, summaryActionItems: null,
    }));
    const reads: string[] = [];
    const actionCalls: string[] = [];
    const identities: unknown[] = [];
    let activeActions = 0;
    let maxActiveActions = 0;
    let nativeCalls = 0;
    const forbiddenNative = async () => { nativeCalls++; throw new Error("Task attempted native message/model/memory work"); };
    let releaseFirstRead!: () => void;
    let signalFirstRead!: () => void;
    const firstRead = new Promise<void>(resolve => { signalFirstRead = resolve; });
    const heldRead = new Promise<void>(resolve => { releaseFirstRead = resolve; });
    const runtime = {
      actions: [tinycloudFindMeetingsAction, tinycloudReadMeetingAction].map(action => ({ ...action,
        handler: async (...args: any[]) => {
          const message = args[1];
          const options = args[3];
          identities.push({ entityId: message.entityId, roomId: message.roomId, agentId: message.agentId });
          actionCalls.push(`${action.name}:${options.args.meetingRef ?? "range"}`);
          maxActiveActions = Math.max(maxActiveActions, ++activeActions);
          try { return await action.handler(...args); } finally { activeActions--; }
        },
      })),
      useModel: forbiddenNative, createMemory: forbiddenNative, evaluate: forbiddenNative,
      processActions: forbiddenNative, messageService: { handleMessage: forbiddenNative },
    };
    setTranscriptRegistry(runtime, {
      readerFor: (entityId: string, roomId: string) => {
        expect(entityId).toBe(addressToEntityId(ADDRESS, TINYCHAT_AGENT_ID));
        expect(roomId).toBe("room-private-multi-round");
        return {
          listMetadata: async () => records,
          getMetadata: async (reference: string) => records.find(record => record.meetingRef === reference) ?? null,
          getTranscript: async (_source: string, sourceId: string) => {
            reads.push(sourceId);
            if (sourceId === "one") { signalFirstRead(); await heldRead; }
            return [{ text: `${sourceId === "one" ? "The release moved to Friday." : "The documentation review stays on Monday."} ${rawCanary}`,
              speaker_name: sourceId === "one" ? "Alpha" : "Beta", start_time: sourceId === "one" ? 5 : 10 }];
          },
        };
      },
      selectedMeetingFor: () => null, selectMeeting: () => {}, setSelection: () => {},
    });
    cleanup.push(async () => { setTranscriptRegistry(runtime, null); });
    let providerCount = 0;
    let synthesis!: ReadableStreamDefaultController<Uint8Array>;
    let signalSynthesis!: () => void;
    const synthesisOpened = new Promise<void>(resolve => { signalSynthesis = resolve; });
    const providerEnd = (index: number, reason: "tool_calls" | "stop") => frame({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: index * 10, completion_tokens: index * 3 } }) + "data: [DONE]\n\n";
    const app = await setup(async () => {
      const index = ++providerCount;
      if (index === 1) return new Response(frame({ id: "private-planning-1", choices: [{ delta: { content: discoveryDraft, tool_calls: [{ index: 0, id: "find-range", function: {
        name: "tinycloud_find_meetings", arguments: JSON.stringify({ from: "2026-09-07", to: "2026-09-13", sort: "oldest" }),
      } }] } }] }) + providerEnd(index, "tool_calls"));
      if (index === 2) return new Response(frame({ id: "private-planning-2", choices: [{ delta: { content: readDraft, tool_calls: records.map((record, index) => ({ index, id: `read-${index}`, function: {
        name: "tinycloud_read_meeting", arguments: JSON.stringify({ meetingRef: record.meetingRef, focus: "summary", includeBody: true }),
      } })) } }] }) + providerEnd(index, "tool_calls"));
      if (index !== 3) throw new Error("Unexpected extra provider request in joint private proof");
      return new Response(new ReadableStream({ start(controller) { synthesis = controller; signalSynthesis(); } }));
    }, true, async agentId => { expect(agentId).toBe(TINYCHAT_AGENT_ID); return runtime; });

    const iterator = app.run("private-multi-round", "Summarize my meetings from 2026-09-07 through 2026-09-13.");
    let firstDelivered = false;
    const first = iterator.next().then(value => { firstDelivered = true; return value; });
    expect(await bounded(app.taskResponse)).toBe(200);
    await bounded(firstRead);
    expect(reads).toEqual(["one"]);
    expect(actionCalls).toEqual(["TINYCLOUD_FIND_MEETINGS:range", "TINYCLOUD_READ_MEETING:joint-one"]);
    expect(app.providerRequests).toHaveLength(2);
    expect(firstDelivered).toBe(false);
    expect(takePendingCompletion("private-multi-round")).toBeNull();
    releaseFirstRead();
    await bounded(synthesisOpened);
    expect(reads).toEqual(["one", "two"]);
    expect(maxActiveActions).toBe(1);
    expect(actionCalls).toEqual(["TINYCLOUD_FIND_MEETINGS:range", "TINYCLOUD_READ_MEETING:joint-one", "TINYCLOUD_READ_MEETING:joint-two"]);
    const answer = "The release moved to Friday [M1:E2, Alpha, 00:00:05]. The documentation review stays on Monday [M2:E2, Beta, 00:00:10].";
    synthesis.enqueue(encoder.encode(frame({ id: "private-final-provider", choices: [{ delta: { content: answer } }] })));
    await Bun.sleep(10);
    expect(firstDelivered).toBe(false);
    expect(takePendingReceipt("private-multi-round")).toBeNull();
    synthesis.enqueue(encoder.encode(providerEnd(3, "stop")));
    synthesis.close();
    const delivered = await bounded(first);
    expect(delivered.done).toBe(false);
    const finalText = textOf(delivered.value)!;
    expect(finalText).toContain(answer);
    expect(finalText).toContain("Coverage");
    expect((await bounded(iterator.next())).done).toBe(true);
    expect(takePendingReceipt("private-multi-round")).toEqual({ modelId: MODEL, usage: { promptTokens: 60, completionTokens: 18 } });
    expect(takePendingReceipt("private-multi-round")).toBeNull();
    expect(takePendingCompletion("private-multi-round")).toBeNull();
    expect(app.tasks).toHaveLength(1);
    expect(app.providerRequests).toHaveLength(3);
    for (const request of app.providerRequests.slice(0, 2)) expect(request.messages.filter((message: any) => message.content.includes("Local controlled account context."))).toHaveLength(1);
    expect(app.providerRequests[2].tools).toBeUndefined();
    expect(app.providerRequests[2].reasoning_effort).toBe("low");
    const cleanSynthesis = JSON.stringify(app.providerRequests[2]);
    expect(cleanSynthesis).toContain(rawCanary);
    expect(cleanSynthesis).toContain("[M1:E2, Alpha, 00:00:05]");
    expect(cleanSynthesis).toContain("[M2:E2, Beta, 00:00:10]");
    for (const hidden of ["Local controlled account context.", discoveryDraft, readDraft]) expect(cleanSynthesis).not.toContain(hidden);
    expect(identities).toEqual(Array.from({ length: 3 }, () => ({ entityId: addressToEntityId(ADDRESS, TINYCHAT_AGENT_ID), roomId: "room-private-multi-round", agentId: TINYCHAT_AGENT_ID })));
    expect(app.backendCalls.map(url => new URL(url).pathname)).toEqual(["/capabilities", "/tasks"]);
    expect(app.backendProviderCalls()).toBe(0);
    expect(app.nativeRuntimeCalls()).toBe(0);
    expect(nativeCalls).toBe(0);
    const privateEvents = await bounded(app.privateStreams[0]);
    expect(privateEvents.filter(event => event.type === "content_delta")).toEqual([]);
    expect(privateEvents.filter(event => event.type === "final")).toHaveLength(1);
    expect(privateEvents.at(-1)).toMatchObject({ type: "final", outcome: "success", answer: { kind: "meeting_prose", delivery: "buffered" }, answerIsProviderVerbatim: false,
      finalProviderCompletionId: "private-final-provider", promptTokens: 60, completionTokens: 18, usageCompleteness: "complete" });
    const browser = await bounded(app.browserStreams[0]);
    expect(browser.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(browser.match(/"prompt_tokens":60/g)).toHaveLength(1);
    for (const hidden of [rawCanary, discoveryDraft, readDraft, "private-planning-1", "private-planning-2", "private-final-provider", "joint-one", "joint-two", app.tasks[0].executionId]) {
      expect(browser).not.toContain(hidden);
      expect(finalText).not.toContain(hidden);
    }
    for (const hidden of [rawCanary, discoveryDraft, readDraft, "joint-one", "joint-two"]) {
      expect(JSON.stringify(privateEvents)).not.toContain(hidden);
      expect(JSON.stringify(diagnosticLogs)).not.toContain(hidden);
    }
  });
});
