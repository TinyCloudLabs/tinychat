import { expect, test } from "bun:test";
import express from "express";
import {
  createAgentChatHandler,
  type AgentChatConfig,
} from "../routes/agent-chat.js";
const reference = {
  source: "fireflies",
  sourceId: "a",
  meetingRef: "a",
  revision: "a".repeat(64),
};
const envelope = {
  contractVersion: 3,
  kind: "evidence",
  reference,
  basis: "transcript",
  state: "complete",
  metadata: {
    title: "Design",
    startedAt: null,
    organizerEmail: null,
    participants: [],
    metadata: {},
  },
  original: {
    digest: "d".repeat(64),
    byteLength: 20,
    recordCount: 1,
    extent: "known",
    captureComplete: null,
  },
  coverage: {
    fetched: true,
    decodedRecords: 1,
    totalRecords: 1,
    suppliedRecords: 1,
    processedRecords: null,
  },
  spans: [{ text: "Cobalt was approved.", recordIndex: 0, start: 0, end: 20 }],
  omissions: [],
  overviewProvenance: null,
};
const sse = (content: string, finish = "stop") =>
  new Response(
    `data: ${JSON.stringify({ id: "provider-fixture", choices: [{ delta: { content }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
  );
async function route(body: any, options: any = {}) {
  const requests: any[] = [];
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    (req as any).user = { address: "0xsynthetic" };
    next();
  });
  const config: AgentChatConfig = {
    agentId: "synthetic",
    entityIdFor: () => "synthetic-entity",
    streamPolicy: { heartbeatMs: 25, turnTimeoutMs: 120000, drainGraceMs: 100 },
    elizaServiceUrl: "http://companion.invalid",
    elizaServiceSecret: "synthetic",
    redpillBaseUrl: "http://provider.invalid",
    redpillApiKey: "synthetic",
    defaultModel: () => "z-ai/glm-5.3",
    isModelOffered: () => true,
    meetingProvider: {
      model: "z-ai/glm-5.3",
      admitted: true,
      countInputTokens: () => 100,
      contextTokens: 1048576,
    },
    fetchImpl: (async (url, init) => {
      const request = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ url: String(url), ...request });
      if (String(url).endsWith("/capabilities"))
        return Response.json({
          meetingRetrieval: { contractVersion: 3 },
          buildRevision: "fixture",
        });
      if (String(url).includes("/tools/"))
        return Response.json({ result: { data: envelope } });
      if (options.response) return options.response(request, requests);
      if (request.messages[0].content.startsWith("Interpret only"))
        return sse(JSON.stringify({ kind: "general" }));
      if (request.messages[0].content.startsWith("Return only JSON"))
        return sse(
          JSON.stringify({
            answers: [
              {
                obligationId: "M1:summary",
                text: "Cobalt was approved.",
                citationIds: ["M1:E1"],
              },
            ],
          }),
        );
      return sse("Hello.");
    }) as typeof fetch,
  };
  app.post("/api/agent/chat", createAgentChatHandler(config));
  const server = await new Promise<any>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/agent/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: res.status, text: await res.text(), requests };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const selected = () => ({
  model: "z-ai/glm-5.3",
  messages: [
    { role: "system", content: "PRIVATE FACTUAL MEMORY" },
    { role: "user", content: "Summarize A" },
  ],
  publicTools: false,
  turn: {
    turnId: "turn-route",
    sentAt: Date.now(),
    intent: {
      mode: "analysis",
      parts: [{ id: "summary", question: "Summarize" }],
      references: [reference],
    },
  },
});
test("actual agent route handles agent-off private selected request with typed persisted result before DONE", async () => {
  const r = await route(selected());
  expect(r.status).toBe(200);
  expect(r.text).toContain('"meeting_result"');
  expect(r.text).toContain('"status":"completed"');
  expect(r.text.indexOf('"meeting_result"')).toBeLessThan(
    r.text.indexOf("[DONE]"),
  );
  const models = r.requests.filter((r) => r.url.includes("provider"));
  expect(models).toHaveLength(1);
  expect(models[0].tools).toBeUndefined();
  expect(JSON.stringify(models)).not.toContain("PRIVATE FACTUAL MEMORY");
});
test("ordinary general chat retains memory after classification and public toggle", async () => {
  const r = await route({
    messages: [{ id: "u", role: "user", content: "Hello" }],
    turn: { turnId: "ordinary", sentAt: Date.now() },
    publicTools: false,
    preparation: { memory: "Prefer concise replies", checkpoint: null },
  });
  const models = r.requests.filter((r) => r.url.includes("provider"));
  expect(models).toHaveLength(2);
  expect(JSON.stringify(models[0])).not.toContain("Prefer concise replies");
  expect(JSON.stringify(models[1])).toContain("Prefer concise replies");
  expect(models[1].tools).toBeUndefined();
  expect(r.text).toContain("Hello.");
  expect(r.text).not.toContain("meeting_result");
});
test("legacy client missing durable turn protocol receives upgrade-required", async () => {
  const r = await route({ messages: [{ role: "user", content: "Hello" }] });
  expect(r.status).toBe(426);
  expect(r.requests).toHaveLength(0);
});
test("malformed turn ID is rejected before any provider or evidence read", async () => {
  const body = selected();
  (body.turn as any).turnId = { bad: true };
  const r = await route(body);
  expect(r.status).toBe(400);
  expect(r.requests).toHaveLength(0);
});
test("ordinary 400 and length output are terminal without automatic retry", async () => {
  for (const response of [
    () => new Response("bad request", { status: 400 }),
    () => sse("truncated", "length"),
  ]) {
    const r = await route(selected(), { response });
    expect(r.requests.filter((r) => r.url.includes("provider"))).toHaveLength(
      1,
    );
    expect(r.text).toContain('"status":"failed"');
    expect(r.text).not.toContain('"status":"completed"');
  }
});

test("actual route preserves known billed usage but rejects private tokenizer drift without recovery", async () => {
  const r = await route(selected(), {
    response: () =>
      new Response(
        `data: ${JSON.stringify({ id: "accounting-fixture", choices: [{ delta: { content: "UNADMITTED_PROVIDER_CANARY" }, finish_reason: "stop" }], usage: { prompt_tokens: 99, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "x-request-id": "synthetic-accounting-request" } },
      ),
  });
  expect(
    r.requests.filter((request) => request.url.includes("provider")),
  ).toHaveLength(1);
  expect(r.text).toContain('"status":"failed"');
  expect(r.text).toContain('"prompt_tokens":99');
  expect(r.text).toContain('"completion_tokens":5');
  expect(r.text).toContain('"providerStatus":200');
  expect(r.text).toContain("synthetic-accounting-request");
  expect(r.text).not.toContain("UNADMITTED_PROVIDER_CANARY");
});
