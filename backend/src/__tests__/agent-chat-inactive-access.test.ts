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
