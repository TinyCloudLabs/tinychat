import { afterEach, describe, expect, it } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import { createAgentRouter } from "../routes/agent.js";
import type { AgentChatConfig } from "../routes/agent-chat.js";

const key = `0x${"02".repeat(32)}`;
const address = "0x1111111111111111111111111111111111111111";
const entityId = "8ed637c2-9747-4d8e-a36f-803e1c24bc10";
const model = "moonshotai/kimi-k3";
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const originalPaywall = process.env.PAYWALL_ENABLED;
afterEach(() => { if (originalPaywall === undefined) delete process.env.PAYWALL_ENABLED; else process.env.PAYWALL_ENABLED = originalPaywall; });

type SessionFixture = { status: number; body: unknown } | "throw" | "hang";
const activeSession: SessionFixture = { status: 200, body: { entityId, status: "active", transcriptStatus: "active", revision: "fixture-revision", state: "active" } };

async function setup(overrides: Partial<AgentChatConfig> = {}, session: SessionFixture = activeSession) {
  process.env.PAYWALL_ENABLED = "false";
  const calls: string[] = [];
  const requests: Record<string, any>[] = [];
  const statusSignals: Array<AbortSignal | undefined> = [];
  const fetchImpl = (async (input, init) => {
    const url = String(input); calls.push(url);
    if (url === `http://service.test/sessions/${entityId}`) {
      statusSignals.push(init?.signal ?? undefined);
      if (session === "throw") throw new Error("connection refused");
      // Ignores its signal: the router's own bound must still release the turn.
      if (session === "hang") return new Promise<Response>(() => {});
      return Response.json(session.body, { status: session.status });
    }
    if (url.endsWith("/capabilities")) return Response.json({ chatTasks: { version: 1, enabled: true, cancellation: true, providerProfile: "tinychat-redpill", models: [model] } });
    if (url.endsWith("/tasks")) {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      const envelope = { executionId: body.executionId };
      const usage = { promptTokens: 10, completionTokens: 5, startedAttempts: 1, reportedAttempts: 1, finalizedAttempts: 1, usageCompleteness: "complete" };
      return new Response([
        frame({ ...envelope, seq: 1, type: "accepted", version: 1, model, deadlineAt: body.deadlineAt }),
        frame({ ...envelope, seq: 2, type: "content_delta", text: "Ordinary answer." }),
        frame({ ...envelope, seq: 3, type: "final", model, outcome: "success", ...usage, answer: { kind: "model_text", delivery: "streamed" }, answerIsProviderVerbatim: true, finalProviderCompletionId: "provider-completion" }),
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error("Backend must not invoke providers/tools on task path");
  }) as typeof fetch;
  const app = express();
  app.use(express.json()); app.use(createCsrfMiddleware());
  const cfg: AgentChatConfig = {
    agentId: "92361e74-91ed-43a2-9656-5cc37ff3a07a", entityIdFor: () => entityId,
    elizaServiceUrl: "http://service.test", elizaServiceSecret: "local-service-test",
    redpillApiKey: "unused", redpillBaseUrl: "http://provider.test", defaultModel: () => model,
    isModelOffered: value => value === model, fetchImpl,
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 3000, drainGraceMs: 100 },
    elizaTasksEnabled: true,
    ...overrides,
  };
  app.use("/api/agent", createAgentRouter({ agentDid: "did:key:test", elizaServiceUrl: cfg.elizaServiceUrl, elizaServiceSecret: cfg.elizaServiceSecret, authMiddleware: createAuthMiddleware(key), chat: cfg, fetchImpl, sessionStatusTimeoutMs: 50 }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/chat`;
  const token = (await issueSessionToken(address, key)).token;
  const headers = { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${token}` };
  return { calls, requests, statusSignals, url, headers, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe("admitted Eliza task route", () => {
  it("submits one trusted task and preserves the existing browser content/ID/usage/DONE contract", async () => {
    const run = await setup({ meetingContentRetrievalEnabled: true });
    try {
      const response = await fetch(run.url, { method: "POST", headers: run.headers, body: JSON.stringify({ model, roomId: "thread-local", messages: [{ role: "system", content: "Existing account context" }, { role: "user", content: "Hello" }], clientContext: { localDate: "2026-09-15", timeZone: "Europe/Lisbon" }, entityId: "forged" }) });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(run.requests).toHaveLength(1);
      expect(run.calls).toEqual([`http://service.test/sessions/${entityId}`, "http://service.test/capabilities", "http://service.test/tasks"]);
      expect(run.requests[0]).toMatchObject({ version: 1, entityId, roomId: "thread-local", model: { id: model }, calendar: { localDate: "2026-09-15", timeZone: "Europe/Lisbon" }, accessRevision: "fixture-revision" });
      expect(run.requests[0].allowedTools).toContain("tinycloud_read_meeting");
      expect(run.requests[0].messages).toHaveLength(2);
      expect(body).not.toContain("delegation_error");
      expect(body.match(/Ordinary answer\./g)).toHaveLength(1);
      expect(body).toContain('"id":"provider-completion"');
      expect(body).not.toContain(run.requests[0].executionId);
      expect(body).toContain('"prompt_tokens":10');
      expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
    } finally { await run.close(); }
  });

  it("rejects unauthenticated, CSRF and denied model requests before any task work", async () => {
    const run = await setup();
    try {
      const validBody = JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }] });
      expect((await fetch(run.url, { method: "POST", headers: { ...run.headers, authorization: "" }, body: validBody })).status).toBe(401);
      expect((await fetch(run.url, { method: "POST", headers: { ...run.headers, "X-Requested-With": "" }, body: validBody })).status).toBe(403);
      expect((await fetch(run.url, { method: "POST", headers: run.headers, body: JSON.stringify({ model: "denied", messages: [{ role: "user", content: "Hello" }] }) })).status).toBe(403);
      expect(run.calls).toHaveLength(0);
    } finally { await run.close(); }
  });
});

describe("task route reports missing private access instead of hiding it", () => {
  const cases: Array<[string, SessionFixture, string]> = [
    ["no session (404 none)", { status: 404, body: { status: "none", state: "none", revision: "r2" } }, "delegation_required"],
    ["a disconnected session", { status: 404, body: { status: "none", state: "disconnected", revision: "r3" } }, "delegation_required"],
    ["a stale grant", { status: 200, body: { entityId, status: "stale", transcriptStatus: "active", revision: "r4" } }, "delegation_required"],
    ["an expired grant", { status: 200, body: { entityId, status: "expired", transcriptStatus: "expired", revision: "r5" } }, "delegation_expired"],
    ["a grant that fails policy (400)", { status: 400, body: { error: "invalid_transcript_delegation" } }, "delegation_required"],
    ["an unreachable service", "throw", "delegation_unverified"],
    ["a service error", { status: 503, body: { error: "private_access_unavailable" } }, "delegation_unverified"],
  ];
  for (const [label, session, code] of cases) it(`${label}: signals ${code} first, then answers from public tools`, async () => {
    const run = await setup({}, session);
    try {
      const response = await fetch(run.url, { method: "POST", headers: run.headers, body: JSON.stringify({ model, messages: [{ role: "user", content: "What did we decide yesterday?" }] }) });
      const body = await response.text();
      expect(response.status).toBe(200);
      const signal = body.indexOf(`"delegation_error":{"code":"${code}"}`);
      expect(signal).toBeGreaterThan(-1);
      expect(signal).toBeLessThan(body.indexOf("Ordinary answer."));
      expect(body).not.toContain("stream_error");
      expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
      expect(run.requests).toHaveLength(1);
      expect(run.requests[0].allowedTools).toEqual(["web_search"]);
      expect(run.requests[0].accessRevision).toBeUndefined();
      // Eliza's planner is told why meeting tools are missing, ahead of the browser's messages.
      const [notice, ...rest] = run.requests[0].messages;
      expect(notice.role).toBe("system");
      expect(notice.content).toContain("Settings > Agent access");
      expect(notice.content).toContain("do not suggest choosing a different model");
      if (code === "delegation_unverified") expect(notice.content).toContain("could not be verified");
      expect(rest).toEqual([{ role: "user", content: "What did we decide yesterday?" }]);
    } finally { await run.close(); }
  });

  it("bounds a status call that never answers and still serves the turn", async () => {
    const run = await setup({}, "hang");
    try {
      const started = Date.now();
      const response = await fetch(run.url, { method: "POST", headers: run.headers, body: JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }] }) });
      const body = await response.text();
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(body).toContain('"delegation_error":{"code":"delegation_unverified"}');
      expect(body).toContain("Ordinary answer.");
      expect(run.requests[0].allowedTools).toEqual(["web_search"]);
      expect(run.statusSignals).toHaveLength(1);
      expect(run.statusSignals[0]?.aborted).toBe(true);
    } finally { await run.close(); }
  });
});
