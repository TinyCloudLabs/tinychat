import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type Stripe from "stripe";
import { createAgentRouter } from "../routes/agent.js";
import type { AgentChatConfig } from "../routes/agent-chat.js";
import { addressToEntityId, TINYCHAT_AGENT_ID } from "../entity-id.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage, getUsage } from "../billing/usage.js";
import { TIERS } from "../billing/tiers.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const MODEL = "phala/gpt-oss-120b";
const ALICE_ENTITY = addressToEntityId(ALICE, TINYCHAT_AGENT_ID);
const BOB_ENTITY = addressToEntityId(BOB, TINYCHAT_AGENT_ID);
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const encoder = new TextEncoder();
let quiet: ReturnType<typeof spyOn>;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Router lifecycle fixture did not settle")), 1500); })]); }
  finally { clearTimeout(timer!); }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

beforeEach(() => {
  process.env.PAYWALL_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "local-stripe-fixture";
  process.env.REDPILL_API_KEY = "local-catalog-fixture";
  process.env.LEDGER_CREDIT_GATE_ENABLED = "false";
  _resetUsage(); _resetCache(); _resetCatalogCache();
  _setStripeClient({ customers: { search: async () => ({ data: [] }) } } as unknown as Stripe);
  globalThis.fetch = (async input => {
    if (!String(input).endsWith("/models")) throw new Error("Unexpected external network request");
    return Response.json({ data: [{ id: MODEL, context_length: 100_000, pricing: { prompt: "0.000001", completion: "0.000001" } }] });
  }) as typeof fetch;
  quiet = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...originalEnv }; globalThis.fetch = originalFetch; quiet.mockRestore();
  _setStripeClient(null); _resetCache(); _resetUsage(); _resetCatalogCache();
});

interface TaskFixture {
  request: { executionId: string; entityId: string; allowedTools: string[]; accessRevision?: string; deadlineAt: number };
  stream: ReadableStreamDefaultController<Uint8Array>;
  sequence: number;
  closed: boolean;
}
function fixture() {
  const deleteStarted = deferred(); const releaseDelete = deferred(); const cancelled = deferred();
  const aliceBlocked = deferred(); const aliceAccounted = deferred();
  const tasks: TaskFixture[] = [];
  const waiters: Array<() => void> = [];
  const cancellations: Array<{ executionId: string; entityId: string }> = [];
  const entries: Array<Record<string, unknown>> = [];
  const captures: Array<{ account: string; chunks: string[]; response: express.Response }> = [];
  const active = new Set([ALICE_ENTITY, BOB_ENTITY]);
  const usage = (attempts: number) => ({ promptTokens: 17 * attempts, completionTokens: 5 * attempts, startedAttempts: attempts, reportedAttempts: attempts, finalizedAttempts: attempts, usageCompleteness: "complete" });
  const emit = (task: TaskFixture, type: string, value: object) => task.stream.enqueue(encoder.encode(`data: ${JSON.stringify({ executionId: task.request.executionId, seq: ++task.sequence, type, ...value })}\n\n`));
  const finish = (task: TaskFixture, delivery: "streamed" | "buffered", text: string, attempts = 2) => {
    if (task.closed) return;
    if (delivery === "streamed") emit(task, "content_delta", { text });
    emit(task, "final", { model: MODEL, outcome: "success", ...usage(attempts), answer: { kind: delivery === "buffered" ? "meeting_prose" : "model_text", delivery, ...(delivery === "buffered" ? { text } : {}) }, answerIsProviderVerbatim: delivery === "streamed", ...(delivery === "streamed" ? { finalProviderCompletionId: "synthetic-provider-final" } : {}) });
    task.closed = true; task.stream.close();
  };
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-service-secret");
    if (url.pathname === "/capabilities") return Response.json({ chatTasks: { version: 1, enabled: true, cancellation: true, providerProfile: "tinychat-redpill", models: [MODEL] } });
    if (url.pathname.startsWith("/sessions/")) {
      const entity = decodeURIComponent(url.pathname.slice("/sessions/".length));
      if (init?.method === "DELETE") {
        expect(entity).toBe(ALICE_ENTITY);
        active.delete(entity); deleteStarted.resolve();
        await releaseDelete.promise;
        return Response.json({ status: "none", state: "disconnected", revision: `${entity}:2` });
      }
      return Response.json(active.has(entity)
        ? { status: "active", transcriptStatus: "active", revision: `${entity}:1` }
        : { status: "none", state: "disconnected", revision: `${entity}:2` }, { status: active.has(entity) ? 200 : 404 });
    }
    if (url.pathname.endsWith("/cancel")) {
      const body = JSON.parse(String(init?.body));
      cancellations.push({ executionId: url.pathname.split("/")[2], entityId: body.entityId });
      cancelled.resolve();
      return Response.json({});
    }
    if (url.pathname === "/tasks") {
      const request = JSON.parse(String(init?.body));
      return new Response(new ReadableStream<Uint8Array>({ start(stream) {
        const task: TaskFixture = { request, stream, sequence: 0, closed: false };
        tasks.push(task);
        emit(task, "accepted", { version: 1, model: MODEL, deadlineAt: request.deadlineAt });
        emit(task, "usage", usage(1));
        emit(task, "content_delta", { text: "EARLY CONTENT" });
        for (const notify of waiters) notify();
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error("Unexpected backend provider or tool request");
  }) as typeof fetch;
  const chat: AgentChatConfig = {
    agentId: TINYCHAT_AGENT_ID, entityIdFor: account => addressToEntityId(account, TINYCHAT_AGENT_ID),
    elizaServiceUrl: "https://synthetic-service.test", elizaServiceSecret: "synthetic-service-secret",
    redpillApiKey: "unused", redpillBaseUrl: "https://unused-provider.test", fetchImpl,
    defaultModel: () => MODEL, isModelOffered: value => value === MODEL, elizaTasksEnabled: true,
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 5000, drainGraceMs: 100 },
    flusher: { enqueue(entry) { entries.push(entry as unknown as Record<string, unknown>); if (entry.account === ALICE) aliceAccounted.resolve(); } } as AgentChatConfig["flusher"],
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    if (req.path !== "/api/agent/chat") return next();
    const account = String(req.headers["x-test-account"]);
    const capture = { account, chunks: [] as string[], response: res };
    const block = account === ALICE && !captures.some(value => value.account === ALICE);
    captures.push(capture);
    const write = res.write.bind(res);
    res.write = ((chunk: Uint8Array | string, ...rest: unknown[]) => {
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      capture.chunks.push(text);
      const result = (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      if (block && text.includes("EARLY CONTENT")) { aliceBlocked.resolve(); return false; }
      return result;
    }) as typeof res.write;
    next();
  });
  app.use("/api/agent", createAgentRouter({
    agentDid: "did:pkh:eip155:1:0x3333333333333333333333333333333333333333",
    elizaServiceUrl: chat.elizaServiceUrl, elizaServiceSecret: chat.elizaServiceSecret, fetchImpl, chat,
    authMiddleware(req, res, next) {
      const account = req.headers["x-test-account"];
      if (account !== ALICE && account !== BOB) { res.status(401).json({ error: "unauthorized" }); return; }
      req.user = { address: account }; next();
    },
  }));
  return { app, tasks, captures, cancellations, entries, deleteStarted, releaseDelete, cancelled, aliceBlocked, aliceAccounted, emit, finish,
    waitForTask(entityId: string, count: number) {
      return new Promise<TaskFixture>(resolve => {
        const check = () => { const matches = tasks.filter(task => task.request.entityId === entityId); if (matches.length >= count) resolve(matches[count - 1]); };
        waiters.push(check); check();
      });
    },
  };
}

describe("authenticated router disconnect while task accounting drains", () => {
  for (const delivery of ["streamed", "buffered"] as const) test(`suppresses queued and late ${delivery} output before DELETE responds, preserves usage and another account`, async () => {
    const f = fixture();
    const server = await new Promise<Server>(resolve => { const running = f.app.listen(0, "127.0.0.1", () => resolve(running)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent`;
    const chat = (account: string) => originalFetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json", "x-test-account": account }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ordinary question" }] }) });
    let deleteSettled = false;
    try {
      const aliceResponse = chat(ALICE).then(response => response.text()).catch(() => "connection closed");
      const alice = await bounded(f.waitForTask(ALICE_ENTITY, 1));
      await bounded(f.aliceBlocked.promise);
      const bobResponse = chat(BOB).then(response => response.text());
      void bobResponse.catch(() => {});
      const bob = await bounded(f.waitForTask(BOB_ENTITY, 1));
      f.emit(alice, "content_delta", { text: "QUEUED PRIVATE CONTENT" });
      await flush();
      const aliceCapture = f.captures.find(value => value.account === ALICE)!;
      const deliveredBeforeDelete = aliceCapture.chunks.join("");
      const deletion = originalFetch(`${base}/session`, { method: "DELETE", headers: { "x-test-account": ALICE } }).then(response => { deleteSettled = true; return response; });
      void deletion.catch(() => {});
      await bounded(f.deleteStarted.promise);
      expect(aliceCapture.response.destroyed).toBe(true);
      expect(deleteSettled).toBe(false);
      await bounded(f.cancelled.promise);
      expect(f.cancellations).toEqual([{ executionId: alice.request.executionId, entityId: ALICE_ENTITY }]);
      f.finish(alice, delivery, "LATE PRIVATE ANSWER");
      await bounded(f.aliceAccounted.promise);
      expect(aliceCapture.chunks.join("")).toBe(deliveredBeforeDelete);
      expect(aliceCapture.chunks.join("")).not.toMatch(/QUEUED PRIVATE|LATE PRIVATE|synthetic-provider-final|"usage"|\[DONE\]/);
      expect(f.entries.filter(entry => entry.account === ALICE)).toEqual([expect.objectContaining({ prompt_tokens: 34, completion_tokens: 10, credits: 1 })]);
      expect(getUsage(ALICE, TIERS.free).used).toBe(1);
      expect(Boolean(f.captures.find(value => value.account === BOB)!.response.destroyed)).toBe(false);
      expect(bob.request.allowedTools).toContain("tinycloud_read_meeting");
      f.finish(bob, "buffered", "OTHER ACCOUNT STILL CONNECTED");
      expect(await bounded(bobResponse)).toContain("OTHER ACCOUNT STILL CONNECTED");
      expect(getUsage(BOB, TIERS.free).used).toBe(1);
      expect(deleteSettled).toBe(false);
      f.releaseDelete.resolve();
      const result = await bounded(deletion);
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ status: "none", state: "disconnected" });
      await bounded(aliceResponse);
      const publicResponse = chat(ALICE).then(response => response.text());
      void publicResponse.catch(() => {});
      const publicTask = await bounded(f.waitForTask(ALICE_ENTITY, 2));
      expect(publicTask.request.allowedTools).toEqual(["web_search"]);
      expect(alice.request.accessRevision).toBe(`${ALICE_ENTITY}:1`);
      f.finish(publicTask, "buffered", "PUBLIC ANSWER", 1);
      expect(await bounded(publicResponse)).toContain("PUBLIC ANSWER");
      expect(f.cancellations).toHaveLength(1);
    } finally {
      f.releaseDelete.resolve();
      for (const task of f.tasks) if (!task.closed) f.finish(task, "buffered", "fixture cleanup", 1);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
