import { expect, test } from "bun:test";
import { orchestrateToolCalling, type AgentChatConfig } from "../routes/agent-chat.js";
import { runMeetingTurn } from "../transcripts/meeting-turn.js";

const kimi = "moonshotai/kimi-k3";
const glm = "z-ai/glm-5.3";
const contentPlan = { kind: "meeting_content", scope: "exact", meetingRef: "meeting-a", purpose: "summary", evidenceRequirement: "overview" };

function response(value: unknown, tool = false) {
  const delta = tool
    ? { tool_calls: [{ index: 0, id: "plan", function: { name: "prepare_meeting_turn", arguments: JSON.stringify(value) } }] }
    : { content: value };
  return new Response(`data: ${JSON.stringify({ id: "completion", choices: [{ delta, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}

function config(fetchImpl: typeof fetch): AgentChatConfig {
  return {
    agentId: "agent", entityIdFor: () => "entity", elizaServiceUrl: "https://eliza.test",
    elizaServiceSecret: "test", redpillApiKey: "test", redpillBaseUrl: "https://model.test",
    defaultModel: () => kimi, isModelOffered: () => true, fetchImpl, meetingTrace: () => {},
    meetingContentRetrievalEnabled: true, meetingContentModelAllowed: model => model === glm,
    streamPolicy: { heartbeatMs: 100, turnTimeoutMs: 30000, drainGraceMs: 100 },
  };
}

function output(frames: string[]) {
  return frames.flatMap(frame => {
    try { return JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content ?? ""; }
    catch { return ""; }
  }).join("");
}

test("an unadmitted Kimi greeting answers without interpretation and offers only public tools", async () => {
  async function greeting(enabled: boolean) {
    const requests: Array<{ model: string; tools: Array<{ function: { name: string } }>; tool_choice: unknown }> = [];
    const frames: string[] = [];
    const cfg = config((async (input, init) => {
      expect(String(input)).toBe("https://model.test/chat/completions");
      requests.push(JSON.parse(String(init?.body)));
      return response("Hello! How can I help?");
    }) as typeof fetch);
    cfg.meetingContentRetrievalEnabled = enabled;
    cfg.meetingContentModelAllowed = () => false;
    const result = await orchestrateToolCalling({ config: cfg, model: kimi,
      messages: [{ role: "user", content: "Hello" }], entityId: "entity", write: frame => { frames.push(frame); } });
    return { result, requests, text: output(frames) };
  }

  const baseline = await greeting(false);
  expect(baseline.result.errorCode).toBeUndefined();
  expect(baseline.text).toBe("Hello! How can I help?");
  expect(baseline.requests).toHaveLength(1);
  expect(baseline.requests[0].tools.map(tool => tool.function.name)).toContain("tinycloud_read_meeting");
  const enabled = await greeting(true);
  expect(enabled.result.errorCode).toBeUndefined();
  expect(enabled.text).toBe(baseline.text);
  expect(enabled.requests).toHaveLength(1);
  expect(enabled.requests[0].model).toBe(kimi);
  expect(enabled.requests[0].tool_choice).toBe("auto");
  expect(enabled.requests[0].tools.map(tool => tool.function.name)).toEqual(["web_search"]);
});

test("an unadmitted model cannot dispatch a private tool it calls despite the offered tools", async () => {
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
  const result = await orchestrateToolCalling({ config: cfg, model: kimi,
    messages: [{ role: "user", content: "Read my meeting" }], entityId: "entity", write: frame => { frames.push(frame); } });
  expect(result.errorCode).toBe("routing_mismatch");
  expect(requests).toHaveLength(1);
  expect(requests[0].tools.map(tool => tool.function.name)).toEqual(["web_search"]);
  expect(privateUrls).toEqual([]);
  expect(output(frames)).not.toContain("Private meeting content");
});

test("an admitted model still interprets a greeting before its ordinary answer", async () => {
  const requests: Array<{ model: string; tools: Array<{ function: { name: string } }>; tool_choice: unknown }> = [];
  const frames: string[] = [];
  const cfg = config((async (input, init) => {
    expect(String(input)).toBe("https://model.test/chat/completions");
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1 ? response({ kind: "general" }, true) : response("Hello!");
  }) as typeof fetch);
  const result = await orchestrateToolCalling({ config: cfg, model: glm,
    messages: [{ role: "user", content: "Hello" }], entityId: "entity", write: frame => { frames.push(frame); } });
  expect(result.errorCode).toBeUndefined();
  expect(output(frames)).toBe("Hello!");
  expect(requests).toHaveLength(2);
  expect(requests.map(request => request.model)).toEqual([glm, glm]);
  expect(requests[0].tool_choice).toEqual({ type: "function", function: { name: "prepare_meeting_turn" } });
  expect(requests[1].tools.map(tool => tool.function.name)).toEqual(["web_search"]);
});

test("an admitted content turn still refuses an incompatible reader before private retrieval", async () => {
  const urls: string[] = [];
  const frames: string[] = [];
  const cfg = config((async input => {
    const url = String(input); urls.push(url);
    if (url === "https://eliza.test/capabilities") return Response.json({ meetingRetrieval: { contractVersion: 1 }, buildRevision: "old-reader" });
    if (url === "https://model.test/chat/completions") return response(contentPlan, true);
    throw new Error("Unexpected private retrieval");
  }) as typeof fetch);
  const result = await orchestrateToolCalling({ config: cfg, model: glm,
    messages: [{ role: "user", content: "Summarize this meeting" }], entityId: "entity", write: frame => { frames.push(frame); } });
  expect(result.errorCode).toBe("meeting_feature_unavailable");
  expect(urls).toEqual(["https://model.test/chat/completions", "https://eliza.test/capabilities"]);
  expect(output(frames)).toContain("compatibility check");
});

test("the content controller retains its own model guard before capability and retrieval", async () => {
  const frames: string[] = [];
  const unexpected = async () => { throw new Error("Unadmitted content must not reach a reader or answer model"); };
  const result = await runMeetingTurn({
    config: config(unexpected as typeof fetch), model: kimi, contextWindowTokens: 32000,
    messages: [{ role: "user", content: "Summarize this meeting" }], entityId: "entity",
    streamErrorCode: () => undefined,
    modelCall: async () => ({ content: "", calls: [{ id: "plan", name: "prepare_meeting_turn", args: JSON.stringify(contentPlan) }],
      inline: false, complete: true, promptTokens: 5, completionTokens: 2, completionId: "completion" }),
    capability: unexpected, dispatch: unexpected, runGeneral: unexpected,
    contentFrame: text => text, toolActivityFrame: () => "", delegationErrorFrame: () => "",
    write: frame => { frames.push(frame); },
  });
  expect(result.errorCode).toBe("meeting_feature_unavailable");
  expect(frames.join("")).toBe("Meeting content answers are not available for this model yet.");
});
