// TC-3462: a failed chat stream's request record says whether the model (charged) or we (free) caused it, so
// failures can be counted by cause. Recorded from the stream terminal, so it does not depend on paywall gating.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { load as loadYaml } from "js-yaml";
import { createAgentChatHandler, type AgentChatAccess, type AgentChatConfig } from "../routes/agent-chat.js";
import { createChatRouter } from "../routes/chat.js";
import { createRequestContextMiddleware, noteRequestRecord, recordMountTemplates, type RequestEvent } from "../request-context.js";

const ADDRESS = "0xfa11ca5e00000000000000000000000000000001";
const model = "z-ai/glm-5.2";
const REQUEST_ID = "0b6f2c1e-9d4a-4e7b-8c3f-2a1d5e6f7a8b";
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const sse = (...frames: string[]) => new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const tmpRoot = mkdtempSync(join("/var/tmp", "tc3462."));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let info: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;

beforeEach(() => {
  // Gating off: the cause must be recorded without a settlement.
  delete process.env.PAYWALL_ENABLED;
  process.env.REDPILL_API_KEY = "local_catalog_test";
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).endsWith("/chat/completions")) return sse(frame({ choices: [{ delta: { content: "Partial" } }] }));
    if (String(input).endsWith("/models")) return Response.json({ data: [{ id: model, context_length: 100_000, pricing: { prompt: "0.000001", completion: "0.000001" } }] });
    throw new Error(`Unexpected global network request ${String(input)}`);
  }) as typeof fetch;
  info = spyOn(console, "info").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  info.mockRestore(); error.mockRestore();
});

function agentConfig(fetchImpl: typeof fetch, over: Partial<AgentChatConfig> = {}): AgentChatConfig {
  return {
    agentId: "92361e74-91ed-43a2-9656-5cc37ff3a07a", entityIdFor: () => "8ed637c2-9747-4d8e-a36f-803e1c24bc10",
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 5000, drainGraceMs: 100 },
    elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "local-test", redpillApiKey: "unused", redpillBaseUrl: "https://provider.test/v1",
    defaultModel: () => model, isModelOffered: value => value === model, fetchImpl, redpillFetch: fetchImpl,
    streamRuntime: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: () => {} },
    ...over,
  };
}

const toolCall = (name: string) => frame({ id: "c", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
const usage = frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } });
// Private access is not active, so the turn offers only web_search.
const noPrivateAccess: AgentChatAccess = {
  capture: () => ({ isCurrent: () => true, onInvalidate: () => () => {} }),
  status: async () => ({ status: "none" }),
};

function taskConfig(code: string) {
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return Response.json({ chatTasks: { version: 1, enabled: true, cancellation: true, providerProfile: "tinychat-redpill", models: [model] } });
    if (!url.endsWith("/tasks")) throw new Error(`unexpected ${url}`);
    const task = JSON.parse(String(init?.body));
    return sse(
      frame({ executionId: task.executionId, type: "accepted", seq: 1, version: 1, model, deadlineAt: task.deadlineAt }),
      frame({ executionId: task.executionId, type: "final", seq: 2, model, outcome: "failed", code, promptTokens: 10, completionTokens: 2,
        startedAttempts: 1, reportedAttempts: 1, finalizedAttempts: 1, usageCompleteness: "complete", answerIsProviderVerbatim: false }),
    );
  }) as typeof fetch;
  return agentConfig(fetchImpl, { elizaTasksEnabled: true });
}

/** Serves one request on an app built by `mount` and resolves with its request record. */
async function served(mount: (app: express.Express) => void, path: string, init?: RequestInit): Promise<RequestEvent> {
  const record = Promise.withResolvers<RequestEvent>();
  const app = express();
  app.use(createRequestContextMiddleware(event => { if (event.event === "tinychat_request") record.resolve(event); }));
  recordMountTemplates(app);
  app.use(express.json());
  mount(app);
  const listening = Promise.withResolvers<void>();
  const server = app.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  try {
    const { port } = server.address() as { port: number };
    await (await originalFetch(`http://127.0.0.1:${port}${path}`, init)).text();
    return await record.promise;
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close(err => err ? closed.reject(err) : closed.resolve());
    await closed.promise;
  }
}

const auth = (req: Request, _res: Response, next: NextFunction) => { req.user = { address: ADDRESS }; next(); };
const chatTurn: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }] }) };
const recordOf = (path: "/api/agent/chat" | "/api/chat", config?: AgentChatConfig) => served(app => {
  if (config) app.post("/api/agent/chat", auth, createAgentChatHandler(config));
  app.use("/api/chat", auth, createChatRouter({ redpillFetch: (input, init) => globalThis.fetch(input, init) }));
}, path, chatTurn);

describe("request record failure_cause", () => {
  test("a tool the model was not offered is the model's", async () => {
    const record = await recordOf("/api/agent/chat", agentConfig(async () => sse(toolCall("tinycloud_find_meetings"), usage, "data: [DONE]\n\n"), { access: noPrivateAccess }));
    expect(record).toMatchObject({ stream: "error", code: "routing_mismatch", failure_cause: "model" });
  });

  test("an invalid meeting plan is the model's, from the meeting terminal", async () => {
    const fetchImpl = (async (input: unknown) => {
      if (String(input).endsWith("/capabilities")) throw new Error("Unexpected capability request");
      return sse(frame({ id: "c", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "prepare_meeting_turn", arguments: "{invalid" } }] }, finish_reason: "tool_calls" }] }), usage, "data: [DONE]\n\n");
    }) as typeof fetch;
    const record = await recordOf("/api/agent/chat", agentConfig(fetchImpl, { meetingContentRetrievalEnabled: true }));
    expect(record).toMatchObject({ stream: "error", code: "interpretation_failed", failure_cause: "model" });
  });

  test("a provider error after content is ours", async () => {
    const record = await recordOf("/api/agent/chat", agentConfig(async () => sse(frame({ choices: [{ delta: { content: "Partial" } }] }), frame({ error: { message: "synthetic provider failure" } }))));
    expect(record).toMatchObject({ stream: "error", code: "upstream_failed", failure_cause: "ours" });
  });

  test("a finished reply carries no cause", async () => {
    const record = await recordOf("/api/agent/chat", agentConfig(async () => sse(frame({ id: "c", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usage, "data: [DONE]\n\n")));
    expect(record.stream).toBe("done");
    expect(record).not.toHaveProperty("failure_cause");
  });

  test("Eliza /tasks: tool_attempt_limit is the model's, agent_failed is ours", async () => {
    expect(await recordOf("/api/agent/chat", taskConfig("tool_attempt_limit"))).toMatchObject({ stream: "error", code: "agent_failed", failure_cause: "model" });
    expect(await recordOf("/api/agent/chat", taskConfig("agent_failed"))).toMatchObject({ stream: "error", code: "agent_failed", failure_cause: "ours" });
  });

  test("an /api/chat upstream that breaks mid-stream is ours", async () => {
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { content: "Partial" } }] })));
        controller.error(new Error("synthetic upstream reset"));
      },
    }), { headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch;
    const record = await recordOf("/api/chat");
    expect(record).toMatchObject({ stream: "error", code: "upstream_failed", failure_cause: "ours" });
  });

  test("only model or ours is kept, and only on a failed stream", async () => {
    const offList = await served(app => app.get("/x", (_req, res) => {
      noteRequestRecord(res, { stream: "error", code: "upstream_failed", failureCause: "provider" as "ours" });
      res.json({ ok: true });
    }), "/x");
    expect(offList).toMatchObject({ stream: "error", code: "upstream_failed" });
    expect(offList).not.toHaveProperty("failure_cause");
    const finished = await served(app => app.get("/x", (_req, res) => {
      noteRequestRecord(res, { stream: "done", failureCause: "model" });
      res.json({ ok: true });
    }), "/x");
    expect(finished).not.toHaveProperty("failure_cause");
  });
});

/** Run emitted lines through the real Vector pipeline and return what reaches the sink. */
async function shipThroughVector(messages: readonly string[]): Promise<Record<string, unknown>[]> {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const shipped = loadYaml(await Bun.file(resolve(repoRoot, "log-shipper/vector.yaml")).text()) as {
    transforms: Record<string, { inputs: string[] }>;
    sinks: { betterstack: { inputs: string[] } };
  };
  shipped.transforms.redact.inputs = ["stdin"];
  const path = join(tmpRoot, `vector-${crypto.randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({
    sources: { stdin: { type: "stdin", decoding: { codec: "json" } } },
    transforms: shipped.transforms,
    sinks: { out: { type: "console", inputs: shipped.sinks.betterstack.inputs, encoding: { codec: "json" } } },
  }));
  const gelf = messages.map(message => JSON.stringify({ message, level: 6, "_tc.logship": "tinychat-backend" })).join("\n");
  const proc = Bun.spawn([process.env.VECTOR_BIN!, "--quiet", "--config", path], {
    env: { PATH: process.env.PATH ?? "", HOME: tmpRoot, TC_HOME: tmpRoot, VECTOR_LOG: "error" },
    stdin: new Blob([gelf + "\n"]), stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited, err).toBe(0);
  return out.split("\n").filter(Boolean).map(text => JSON.parse(text) as Record<string, unknown>);
}

describe.skipIf(!process.env.VECTOR_BIN)("shipper allowlist", () => {
  const base = { event: "tinychat_request", request_id: REQUEST_ID, method: "POST", route: "/api/agent/chat", status: 200, duration_ms: 1, stream: "error", code: "routing_mismatch" };

  test("ships model and ours, drops any other value", async () => {
    const shipped = await shipThroughVector([
      JSON.stringify({ ...base, failure_cause: "model" }),
      JSON.stringify({ ...base, failure_cause: "ours" }),
      JSON.stringify({ ...base, failure_cause: "provider" }),
    ]);
    expect(shipped.map(row => row.failure_cause)).toEqual(["model", "ours", undefined]);
  }, 120_000);

  test("a maximum-width failed record with its cause still fits the request envelope", async () => {
    const shipped = await shipThroughVector([JSON.stringify({
      ...base, method: "CONNECT", route: `/${"a".repeat(63)}`, status: 599, duration_ms: 86399999.9,
      code: "a".repeat(60), failure_cause: "model", credits: "1000+", account_hash: "a".repeat(64),
    })]);
    expect(shipped).toHaveLength(1);
    expect(shipped[0].failure_cause).toBe("model");
    // Same 576-byte envelope as request-record.test.ts; two bytes reserve framing.
    expect(Buffer.byteLength(JSON.stringify(shipped[0])) + 2).toBeLessThanOrEqual(576);
  }, 120_000);
});
