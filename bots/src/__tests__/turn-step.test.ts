import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotManager, type SandboxLauncher } from "../bot";
import type { Frame } from "../rpc";
import { createApp } from "../server";
import { ALLOWED_TOOLS } from "../tool-policy";
import { stepOfTool, TURN_STEP_IDS, type TurnStep, TurnSteps } from "../turn-step";

const hidden = "the query, the page text and the file path";

test("each tool the agent reports is one fixed step, and a name not listed is `tool`", () => {
  expect(stepOfTool("mcp__web_search", { query: hidden })).toEqual({ step: "search" });
  expect(stepOfTool("bash", { command: hidden })).toEqual({ step: "commands" });
  for (const name of ["read", "write", "edit", "glob", "grep"]) expect(stepOfTool(name, { path: hidden })).toEqual({ step: "files" });
  for (const name of ["ask_owner", "request_secret", "propose_action"]) expect(stepOfTool(`mcp__app_${name}`, {})).toEqual({ step: "request" });
  for (const name of ["list_secrets", "call_with_secret"]) expect(stepOfTool(`mcp__app_${name}`, {})).toEqual({ step: "secret" });
  expect(stepOfTool("mcp__app_tinycloud_read_meeting", {})).toEqual({ step: "meetings" });
  expect(stepOfTool("mcp__app_read_card", {})).toEqual({ step: "feed" });
  expect(stepOfTool("mcp__app_read_chat", {})).toEqual({ step: "chats" });
  expect(stepOfTool("mcp__app_read_telegram_chat", {})).toEqual({ step: "telegram" });
  expect(stepOfTool("message_bot", { targetKey: "main", text: hidden })).toEqual({ step: "bot_message" });
  for (const name of ["some_new_tool", "toString", "__proto__", "", 7, null, undefined]) expect(stepOfTool(name, { url: "https://example.com/" })).toEqual({ step: "tool" });
});

test("every tool the gateway serves has a step of its own kind", () => {
  for (const [server, names] of Object.entries(ALLOWED_TOOLS)) {
    for (const name of names) expect([server, name, stepOfTool(`mcp__${server}_${name}`, {}).step]).not.toEqual([server, name, "tool"]);
  }
});

test("a page read carries the page's host and nothing more of its address", () => {
  expect(stepOfTool("mcp__web_fetch", { url: `https://WWW.Tides.Example:8443/whitby/${hidden}?q=${hidden}#${hidden}` }))
    .toEqual({ step: "read_page", host: "www.tides.example" });
  expect(stepOfTool("mcp__web_fetch", { url: "http://10.0.0.7/status", other: hidden })).toEqual({ step: "read_page", host: "10.0.0.7" });
});

test("an address with any doubt about it gives a page read with no host", () => {
  const doubtful = [
    "https://owner:pass@tides.example/", "https://owner@tides.example/", "ftp://tides.example/", "javascript:alert(1)", "tides.example/whitby",
    "https://[::1]/", "https://tides_example.test/", `https://${"a".repeat(2048)}.example/`, "", 42, null, undefined, { host: "tides.example" },
  ];
  for (const url of doubtful) expect(stepOfTool("mcp__web_fetch", { url })).toEqual({ step: "read_page" });
  expect(stepOfTool("mcp__web_fetch", "https://tides.example/")).toEqual({ step: "read_page" });
  expect(stepOfTool("mcp__web_fetch", undefined)).toEqual({ step: "read_page" });
});

test("a turn's steps are said once per change, with thinking between tools", () => {
  const said: TurnStep[] = [];
  const steps = new TurnSteps(step => said.push(step));
  const start = (toolCallId: string, toolName: string, args: unknown = {}) => steps.tool({ type: "tool_execution_start", toolCallId, toolName, args });
  const end = (toolCallId: string) => steps.tool({ type: "tool_execution_end", toolCallId });

  steps.messageEnded();
  steps.messageEnded();
  start("a", "mcp__web_search");
  start("b", "mcp__web_search");
  end("a");
  end("a");
  end("unknown");
  end("b");
  start("c", "mcp__web_fetch", { url: "https://tides.example/a" });
  start("d", "mcp__web_fetch", { url: "https://tides.example/b" });
  start("e", "mcp__web_fetch", { url: "https://other.example/" });
  steps.messageEnded();
  end("c"); end("d"); end("e");
  expect(said).toEqual([
    { step: "thinking" }, { step: "search" }, { step: "thinking" },
    { step: "read_page", host: "tides.example" }, { step: "read_page", host: "other.example" }, { step: "thinking" },
  ]);
});

test("after reply text the next step is said even when it repeats the one before the text", () => {
  const said: TurnStep[] = [];
  const steps = new TurnSteps(step => said.push(step));
  steps.tool({ type: "tool_execution_start", toolCallId: "a", toolName: "bash" });
  steps.wrote();
  steps.tool({ type: "tool_execution_start", toolCallId: "b", toolName: "bash" });
  expect(said).toEqual([{ step: "commands" }, { step: "commands" }]);
});

test("a tool call with no usable id is not followed", () => {
  const said: TurnStep[] = [];
  const steps = new TurnSteps(step => said.push(step));
  for (const toolCallId of ["", "x".repeat(257), 3, undefined]) steps.tool({ type: "tool_execution_start", toolCallId, toolName: "bash" });
  expect(said).toEqual([]);
});

function launcher(): SandboxLauncher {
  return {
    hasState: () => false,
    leftover: () => false,
    launch: async () => {
      const listeners = new Set<(frame: Frame) => void>();
      const exit = Promise.withResolvers<void>();
      const emit = (frame: Frame) => { for (const listener of listeners) listener(frame); };
      const say = (delta: string) => {
        emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta } });
        emit({ type: "message_end", message: { role: "assistant" } });
      };
      const tool = (toolName: string, toolCallId: string, args: unknown) => {
        emit({ type: "tool_execution_start", toolName, toolCallId, args });
        emit({ type: "tool_execution_update", toolName, toolCallId, partialResult: hidden });
        emit({ type: "tool_execution_end", toolName, toolCallId, result: { details: {}, content: hidden } });
      };
      return {
        exited: exit.promise,
        nextId: () => "turn",
        snapshot: async () => {},
        refreshEgress: async () => {},
        stop: async () => exit.resolve(),
        onFrame: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        request: async command => {
          if (command.type === "prompt") {
            say("Checking the tide tables.");
            tool("mcp__web_search", "one", { query: hidden });
            tool("mcp__web_fetch", "two", { url: `https://www.tides.example:8443/whitby?note=${encodeURIComponent(hidden)}` });
            tool("bash", "three", { command: hidden });
            tool("a_tool_added_later", "four", { text: hidden });
            say("High tide is at 14:05.");
            emit({ type: "prompt_result", id: command.id, status: "completed", sessionSettled: true });
          }
          return { agentInvoked: true };
        },
      };
    },
  };
}

test("the reply stream carries each step as a fixed id with a page read's host and nothing else of a tool call", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-steps-"));
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const manager = new BotManager(launcher(), roots, { idleMs: 60_000, turnTimeoutMs: 5_000, maxTurnBytes: 1024 }, 1);
  const owner = `did:pkh:eip155:1:0x${"22".repeat(20)}`;
  const secret = "steps-" + "x".repeat(64);
  try {
    const service = createApp({ secret, accounts: "*", bots: manager });
    const turn = await service(new Request("http://bots.test/v1/bots/main/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "x-tinycloud-owner": owner, "content-type": "application/json" },
      body: '{"text":"When is high tide?"}',
    }));
    const stream = await turn.text();
    const steps = [...stream.matchAll(/^event: step\ndata: (.+)$/gm)].map(match => JSON.parse(match[1]!));
    expect(steps).toEqual([
      { step: "thinking" },
      { step: "search" }, { step: "thinking" },
      { step: "read_page", host: "www.tides.example" }, { step: "thinking" },
      { step: "commands" }, { step: "thinking" },
      { step: "tool" }, { step: "thinking" },
      // The last message ended: thinking until the turn is done.
      { step: "thinking" },
    ]);
    for (const step of steps) expect(TURN_STEP_IDS).toContain(step.step);
    expect(stream).not.toContain(hidden);
    expect(stream).not.toContain("8443");
    expect(stream).not.toContain("whitby");
    expect(stream.indexOf("event: step")).toBeGreaterThan(stream.indexOf("Checking the tide tables."));
    expect(stream.lastIndexOf("event: step")).toBeLessThan(stream.indexOf("event: done"));
  } finally {
    await manager.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
