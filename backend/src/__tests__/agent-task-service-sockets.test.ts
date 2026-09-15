/**
 * Joint backend/Eliza socket proofs. Run beside the matching Eliza worktree:
 * bun test backend/src/__tests__/agent-task-service-sockets.test.ts
 * A standalone TinyChat checkout explicitly skips this joint gate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createAgentTaskClient, type AgentTaskRequest } from "../agent-task-client.js";
import { addressToEntityId, TINYCHAT_AGENT_ID } from "../entity-id.js";

// Real loopback sockets and the actual Eliza HTTP handler; no provider/account credentials.
const elizaSource = new URL("../../../../tinycloud-agents/packages/eliza-service/src/", import.meta.url);
const model = "moonshotai/kimi-k3";
const entityId = addressToEntityId("0x1111111111111111111111111111111111111111", TINYCHAT_AGENT_ID);
const serviceSecret = "loopback-task-service-test";
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const encoder = new TextEncoder();
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Loopback assertion timed out")), ms); })]); }
  finally { clearTimeout(timer!); }
}
function task(): AgentTaskRequest {
  return { version: 1, executionId: crypto.randomUUID(), entityId, model: { id: model, contextWindowTokens: 10_000 }, messages: [{ role: "user", content: "Say hello." }], allowedTools: [], deadlineAt: Date.now() + 10_000 };
}

let savedSecret: string | undefined;
beforeEach(() => { savedSecret = process.env.ELIZA_SERVICE_SECRET; process.env.ELIZA_SERVICE_SECRET = serviceSecret; });
afterEach(() => { if (savedSecret === undefined) delete process.env.ELIZA_SERVICE_SECRET; else process.env.ELIZA_SERVICE_SECRET = savedSecret; });

async function fixture(options: { delayAdmission?: boolean; maxDurationMs?: number; malformedUtf8?: boolean; malformedPrivateUtf8?: boolean } = {}) {
  // Loaded only for an executing joint test; standalone checks have no sibling dependency.
  const { createElizaServiceFetch } = await import(new URL("server.ts", elizaSource).href);
  const { SessionStore } = await import(new URL("session-store.ts", elizaSource).href);
  const arrived = deferred<Request>();
  const releaseAdmission = deferred<void>();
  const handled = deferred<number>();
  const upstreamCancelled = deferred<void>();
  const providerArrived = deferred<void>();
  let providerCalls = 0;
  let taskPosts = 0;
  let cancelPosts = 0;
  const cancelStatuses: number[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
    expect(request.method).toBe("POST");
    const body = await request.json() as any;
    expect(body.model).toBe(model);
    providerCalls++;
    providerArrived.resolve();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const prefix = encoder.encode(frame({ id: "loopback-provider-completion", choices: [{ delta: { content: "Hello" } }] }) + frame({ usage: { prompt_tokens: 17, completion_tokens: 5 } }));
        if (options.malformedUtf8) {
          // The valid usage frame precedes a malformed next frame in the SAME socket write.
          const bytes = new Uint8Array(prefix.length + 1); bytes.set(prefix); bytes[prefix.length] = 0xff;
          controller.enqueue(bytes); controller.close();
        } else controller.enqueue(prefix);
      },
      cancel() { upstreamCancelled.resolve(); },
    }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const host = {
    agentDid: "did:local:unused",
    storageFor: async () => { throw new Error("Ordinary socket test must not use memory storage"); },
    runtimeFor: async () => { throw new Error("Ordinary socket test must not start native runtime"); },
    preflight: async () => { throw new Error("Ordinary socket test must not require delegation"); },
  };
  const handler = createElizaServiceFetch({ host, sessions: new SessionStore(), tasks: { apiKey: "local-provider-only", baseUrl: `http://127.0.0.1:${provider.port}/v1`, models: { [model]: 10_000 }, maxDurationMs: options.maxDurationMs ?? 10_000 } });
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/tasks") {
      taskPosts++;
      arrived.resolve(request);
      if (options.delayAdmission) await releaseAdmission.promise;
      const response = await handler(request);
      handled.resolve(response.status);
      if (options.malformedPrivateUtf8 && response.body) {
        return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
          if (new TextDecoder().decode(chunk).includes('"reportedAttempts":1')) {
            // Simulate transport corruption after a valid private usage frame in one socket write.
            const bytes = new Uint8Array(chunk.length + 3); bytes.set(chunk); bytes.set([0xff, 10, 10], chunk.length);
            controller.enqueue(bytes);
          } else controller.enqueue(chunk);
        } })), { status: response.status, headers: response.headers });
      }
      return response;
    }
    const response = await handler(request);
    if (path.endsWith("/cancel")) { cancelPosts++; cancelStatuses.push(response.status); }
    return response;
  } });
  const baseUrl = `http://127.0.0.1:${service.port}`;
  return {
    baseUrl, client: createAgentTaskClient({ baseUrl, apiKey: serviceSecret }),
    arrived, releaseAdmission, handled, upstreamCancelled, providerArrived,
    providerCalls: () => providerCalls, taskPosts: () => taskPosts, cancelPosts: () => cancelPosts, cancelStatuses,
    async stop() { releaseAdmission.resolve(); await service.stop(true); await provider.stop(true); },
  };
}

describe.skipIf(!existsSync(new URL("server.ts", elizaSource)))("actual Eliza task socket cancellation (requires sibling Eliza checkout)", () => {
  test("an earlier service deadline cancels the provider and retains its reported usage", async () => {
    const local = await fixture({ maxDurationMs: 100 });
    try {
      const start = performance.now();
      const result = await bounded(local.client.run(task(), {}));
      expect(performance.now() - start).toBeLessThan(800);
      expect(result.final?.outcome).toBe("timed_out");
      expect(result.final?.code).toBe("turn_timeout");
      expect(result.usage).toMatchObject({ promptTokens: 17, completionTokens: 5, startedAttempts: 1, reportedAttempts: 1, finalizedAttempts: 0, usageCompleteness: "partial" });
      expect(result.observationComplete).toBe(false);
      expect(local.providerCalls()).toBe(1);
      expect(local.taskPosts()).toBe(1);
      await bounded(local.upstreamCancelled.promise);
    } finally { await local.stop(); }
  });

  test("retains a valid usage frame preceding malformed UTF-8 in the same provider socket chunk", async () => {
    const local = await fixture({ malformedUtf8: true });
    try {
      const result = await bounded(local.client.run(task(), {}));
      expect(result.final?.outcome).toBe("failed");
      expect(result.final?.code).toBe("upstream_incomplete");
      expect(result.usage).toMatchObject({ promptTokens: 17, completionTokens: 5, reportedAttempts: 1, finalizedAttempts: 0, usageCompleteness: "partial" });
      expect(local.providerCalls()).toBe(1);
    } finally { await local.stop(); }
  });

  test("retains a valid usage checkpoint before malformed UTF-8 in the same private socket chunk", async () => {
    const local = await fixture({ malformedPrivateUtf8: true });
    try {
      const result = await bounded(local.client.run(task(), {}));
      expect(result.usage).toMatchObject({ promptTokens: 17, completionTokens: 5, reportedAttempts: 1, finalizedAttempts: 0, usageCompleteness: "partial" });
      expect(result.final).toBeUndefined();
      expect(result.errorCode).toBe("upstream_incomplete");
      expect(result.observationComplete).toBe(false);
      expect(local.providerCalls()).toBe(1);
      expect(local.taskPosts()).toBe(1);
      await bounded(local.upstreamCancelled.promise);
    } finally { await local.stop(); }
  });

  for (const trigger of ["Stop", "deadline"] as const) test(`${trigger} before acceptance closes the original socket after cancel 404 and starts no provider`, async () => {
    const local = await fixture({ delayAdmission: true });
    const controller = new AbortController();
    try {
      const request = task();
      if (trigger === "deadline") request.deadlineAt = Date.now() + 100;
      const pending = local.client.run(request, { signal: controller.signal });
      const incoming = await bounded(local.arrived.promise);
      if (trigger === "Stop") controller.abort();
      const result = await bounded(pending);
      expect(result.cancelled).toBe(true);
      expect(result.accepted).toBe(false);
      expect(result.errorCode).toBe(trigger === "Stop" ? "agent_failed" : "turn_timeout");
      expect(local.cancelStatuses).toEqual([404]);
      expect(local.taskPosts()).toBe(1);
      await pause(20); // Let the loopback peer observe the client's transport abort.
      expect(incoming.signal.aborted).toBe(true);
      local.releaseAdmission.resolve();
      expect(await bounded(local.handled.promise)).toBe(400);
      expect(local.providerCalls()).toBe(0);
    } finally { controller.abort(); await local.stop(); }
  });

  test("closing a real accepted response socket aborts active provider work without a cancel POST", async () => {
    const local = await fixture();
    const controller = new AbortController();
    try {
      const request = task();
      const response = await fetch(`${local.baseUrl}/tasks`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceSecret}` }, body: JSON.stringify(request), signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"accepted"');
      await bounded(local.providerArrived.promise);
      controller.abort();
      await bounded(local.upstreamCancelled.promise);
      expect(local.providerCalls()).toBe(1);
      expect(local.cancelPosts()).toBe(0);
      void reader.cancel().catch(() => {});
    } finally { controller.abort(); await local.stop(); }
  });
});
