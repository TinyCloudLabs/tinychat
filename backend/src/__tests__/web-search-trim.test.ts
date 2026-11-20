// TC-3464: an oversized web_search result is trimmed and the reply completes; reading still stops at a hard bound,
// and meeting reads still fail on overflow (their JSON feeds the evidence packer, where a cut would not validate).
import { describe, expect, test } from "bun:test";
import { orchestrateToolCalling, type AgentChatConfig } from "../routes/agent-chat.js";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const toolJson = (chars: number) => JSON.stringify({ result: { text: "w".repeat(chars) } });

function config(fetchImpl: typeof fetch): AgentChatConfig {
  return {
    agentId: "agent", entityIdFor: () => "entity", elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "test",
    redpillApiKey: "test", redpillBaseUrl: "https://model.test", defaultModel: () => "test-model", isModelOffered: () => true,
    redpillFetch: fetchImpl, fetchImpl,
  };
}

/** One tool round calling `tool`, whose service answers `toolBody`, then an answer round. */
async function turn(tool: string, toolBody: string) {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const dispatched: string[] = [];
  const frames: string[] = [];
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    if (url.includes("/tools/")) { dispatched.push(url.split("/").at(-1)!); return new Response(toolBody); }
    requests.push(JSON.parse(String(init?.body)));
    return new Response((requests.length === 1
      ? frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: tool, arguments: "{}" } }] }, finish_reason: "tool_calls" }] })
      : frame({ id: "answer", choices: [{ delta: { content: "Answer." }, finish_reason: "stop" }] })) + "data: [DONE]\n\n");
  }) as typeof fetch;
  const result = await orchestrateToolCalling({ config: config(fetchImpl), model: "test-model", messages: [{ role: "user", content: "Search the web" }], entityId: "entity", write: f => { frames.push(f); } });
  const text = frames.map(f => { try { return JSON.parse(f.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join("");
  return { result, requests, dispatched, text };
}

describe("web_search results over the 64K cap", () => {
  test("are trimmed with the marker and the model answers", async () => {
    const run = await turn("web_search", toolJson(70_000));
    expect(run.result.errorCode).toBeUndefined();
    expect(run.text).toBe("Answer.");
    expect(run.requests).toHaveLength(2);
    const toolMessages = run.requests[1].messages.filter(message => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content.endsWith("\n[...truncated...]")).toBe(true);
    expect(toolMessages[0].content.length).toBeLessThan(70_000);
  });

  test("up to the 256K read bound complete; one character over still fails", async () => {
    const framing = toolJson(0).length;
    expect((await turn("web_search", toolJson(4 * 65536 - framing))).result.errorCode).toBeUndefined();
    const over = await turn("web_search", toolJson(4 * 65536 - framing + 1));
    expect(over.result.errorCode).toBe("result_size_limit");
    expect(over.requests).toHaveLength(1);
  });
});

test("a meeting read over the 64K cap still fails", async () => {
  const run = await turn("tinycloud_find_meetings", toolJson(70_000));
  expect(run.dispatched).toEqual(["tinycloud_find_meetings"]);
  expect(run.result.errorCode).toBe("result_size_limit");
  expect(run.requests).toHaveLength(1);
  expect(run.text).toBe("");
});
