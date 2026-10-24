import { expect, test } from "bun:test";
import { orchestrateToolCalling, type AgentChatConfig } from "../routes/agent-chat.js";

const kimi = "moonshotai/kimi-k3";

function response(value: unknown) {
  const delta = { content: value };
  return new Response(`data: ${JSON.stringify({ id: "completion", choices: [{ delta, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}

function config(fetchImpl: typeof fetch): AgentChatConfig {
  return {
    agentId: "agent", entityIdFor: () => "entity", elizaServiceUrl: "https://eliza.test",
    elizaServiceSecret: "test", redpillApiKey: "test", redpillBaseUrl: "https://model.test",
    defaultModel: () => kimi, isModelOffered: () => true, fetchImpl,
    streamPolicy: { heartbeatMs: 100, turnTimeoutMs: 30000, drainGraceMs: 100 },
  };
}

function output(frames: string[]) {
  return frames.flatMap(frame => {
    try { return JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? ""; }
    catch { return ""; }
  }).join("");
}

test("a greeting answers in one request and offers the private tools", async () => {
  async function greeting() {
    const requests: Array<{ model: string; tools: Array<{ function: { name: string } }>; tool_choice: unknown }> = [];
    const frames: string[] = [];
    const cfg = config((async (input, init) => {
      expect(String(input)).toBe("https://model.test/chat/completions");
      requests.push(JSON.parse(String(init?.body)));
      return response("Hello! How can I help?");
    }) as typeof fetch);
    const result = await orchestrateToolCalling({ config: cfg, model: kimi,
      messages: [{ role: "user", content: "Hello" }], entityId: "entity", write: frame => { frames.push(frame); } });
    return { result, requests, text: output(frames) };
  }

  const baseline = await greeting();
  expect(baseline.result.errorCode).toBeUndefined();
  expect(baseline.text).toBe("Hello! How can I help?");
  expect(baseline.requests).toHaveLength(1);
  expect(baseline.requests[0].tools.map(tool => tool.function.name)).toContain("tinycloud_read_meeting");
});

test.each([
  ["delegation_required", "connect or reconnect the agent in Settings > Agent access"],
  ["delegation_expired", "has expired"],
  ["delegation_unverified", "could not be verified"],
] as const)("inactive access (%s) asks the user to reconnect, not to change model", async (issue, phrase) => {
  const requests: Array<{ messages: Array<{ content: string }>; tools: Array<{ function: { name: string } }> }> = [];
  const cfg = config((async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return response("I can't access your meetings right now.");
  }) as typeof fetch);
  const result = await orchestrateToolCalling({ config: { ...cfg, privateAccessActive: false, privateAccessIssue: issue }, model: kimi,
    messages: [{ role: "user", content: "What did we decide in yesterday's meeting?" }], entityId: "entity", write: () => {} });
  expect(result.errorCode).toBeUndefined();
  expect(requests).toHaveLength(1);
  const system = requests[0].messages[0].content;
  expect(system).toContain(phrase);
  expect(system).toContain("do not suggest choosing a different model");
  expect(requests[0].tools.map(tool => tool.function.name)).toEqual(["web_search"]);
});

// New tests pinning the retained public-only mode (privateAccessActive === false)
// of the existing tool loop. They are written against that loop directly: no
// interpretation round, no model-admission gate.
const publicOnly = (cfg: AgentChatConfig): AgentChatConfig => ({ ...cfg, privateAccessActive: false, privateAccessIssue: "delegation_expired" });

test("public-only mode refuses a private tool call without dispatching it", async () => {
  const requests: Array<{ tools: Array<{ function: { name: string } }> }> = [];
  const privateUrls: string[] = [];
  const frames: string[] = [];
  const cfg = config((async (input, init) => {
    const url = String(input);
    if (url !== "https://model.test/chat/completions") {
      privateUrls.push(url);
      return Response.json({ result: { text: "Private meeting content must not be returned" } });
    }
    requests.push(JSON.parse(String(init?.body)));
    const delta = { tool_calls: [{ index: 0, id: "private", function: { name: "tinycloud_read_meeting", arguments: '{"meetingRef":"meeting-a"}' } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch);
  const result = await orchestrateToolCalling({ config: publicOnly(cfg), model: kimi,
    messages: [{ role: "user", content: "Read my meeting" }], entityId: "entity", write: frame => { frames.push(frame); } });
  expect(result.errorCode).toBe("routing_mismatch");
  expect(requests).toHaveLength(1);
  expect(requests[0].tools.map(tool => tool.function.name)).toEqual(["web_search"]);
  expect(privateUrls).toEqual([]);
  expect(output(frames)).not.toContain("Private meeting content");
});

test("public-only mode never dispatches or leaks an inline private call that follows streamed prose", async () => {
  let models = 0, dispatches = 0; const frames: string[] = [];
  const fetchImpl = (async (input) => {
    if (String(input).includes("/tools/")) { dispatches++; return Response.json({}); }
    models++;
    const chunks = ["Already streamed prose. ", "<too", "l_call>tinycloud_read_meeting<arg_key>focus</arg_key><arg_value>summary</arg_value></tool_call>"];
    return new Response(chunks.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch;
  const result = await orchestrateToolCalling({ config: publicOnly(config(fetchImpl)), model: kimi, messages: [{ role: "user", content: "Hello" }], entityId: "entity", write: frame => { frames.push(frame); } });
  expect(result.errorCode).toBe("routing_mismatch"); expect(dispatches).toBe(0); expect(models).toBe(1);
  expect(output(frames)).toContain("Already streamed prose."); expect(output(frames)).not.toContain("<tool");
});

test("public-only mode streams ordinary deltas before the answer model finishes", async () => {
  let models = 0; const frames: string[] = []; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)); models++;
    expect(body.tools.map((tool: any) => tool.function.name)).toEqual(["web_search"]); expect(JSON.stringify(body)).not.toContain("tinycloud_find_meetings");
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello now." } }] })}\n\n`));
      await gate;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: " Finished." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)); controller.close();
    } }));
  }) as typeof fetch;
  const run = orchestrateToolCalling({ config: publicOnly(config(fetchImpl)), model: kimi, messages: [{ role: "user", content: "Hello" }], entityId: "entity", write: frame => { frames.push(frame); } });
  try {
    await new Promise(resolve => setTimeout(resolve, 5)); expect(output(frames)).toBe("Hello now.");
  } finally { release(); }
  const result = await run; expect(result.errorCode).toBeUndefined(); expect(output(frames)).toBe("Hello now. Finished."); expect(models).toBe(1);
});
