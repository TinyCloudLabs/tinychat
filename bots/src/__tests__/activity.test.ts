import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotManager, type SandboxLauncher } from "../bot";
import type { Frame } from "../rpc";
import { createApp } from "../server";

const owner = `did:pkh:eip155:1:0x${"11".repeat(20)}`;
const secret = "activity-" + "x".repeat(64);
const hidden = "sandbox tool text and file paths";

function fakeLauncher(): SandboxLauncher {
  return {
    hasState: () => false,
    leftover: () => false,
    launch: async () => {
      const listeners = new Set<(frame: Frame) => void>();
      const exit = Promise.withResolvers<void>();
      const emit = (frame: Frame) => { for (const listener of listeners) listener(frame); };
      const tool = (toolName: string, toolCallId: string, details: unknown, isError = false) => {
        emit({ type: "tool_execution_start", toolName, toolCallId, args: { text: hidden } });
        emit({ type: "tool_execution_update", toolName, toolCallId, partialResult: hidden });
        const end = { type: "tool_execution_end", toolName, toolCallId, result: { details, content: hidden }, isError };
        emit(end);
        emit(end);
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
            emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "unmatched" });
            tool("bash", "one", {});
            tool("bash", "two", {});
            tool("bash", "failed", {}, true);
            tool("read", "unknown", {});
            tool("write", "write", { resolvedPath: `/${hidden}` });
            tool("edit", "edit", { perFileResults: [{ path: `/${hidden}` }, { path: "/other" }, { path: "/failed", isError: true }] });
            emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "pong" } });
            emit({ type: "prompt_result", id: command.id, status: "completed", sessionSettled: true });
          }
          return { agentInvoked: true };
        },
      };
    },
  };
}

test("activity travels through the stream and survives in the restarted journal and separate list", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-activity-"));
  const history = { signerDid: owner, host: "http://127.0.0.1:9137", policy: "notice-then-expiry-30-days" } as const;
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const options = { idleMs: 60_000, turnTimeoutMs: 5_000, maxTurnBytes: 1024, history };
  const manager = new BotManager(fakeLauncher(), roots, options, 1);
  const restarted = new BotManager(fakeLauncher(), roots, options, 1);
  void manager.forOwner(owner).historyPermission(owner, undefined, Date.now() + 3_600_000);
  const url = "http://bots.test/v1/bots/main/messages";
  const headers = { authorization: `Bearer ${secret}`, "x-tinycloud-owner": owner, "content-type": "application/json" };
  try {
    const service = createApp({ secret, accounts: "*", bots: manager });
    const turn = await service(new Request(url, { method: "POST", headers, body: '{"text":"ping"}' }));
    const stream = await turn.text();
    const activity = [...stream.matchAll(/^event: activity\ndata: (.+)$/gm)].map(match => JSON.parse(match[1]!));
    expect(activity.map(record => [record.verb, record.count])).toEqual([["ran_commands", 2], ["changed_files", 2]]);
    expect(stream).not.toContain(hidden);
    expect(stream.indexOf("event: activity")).toBeLessThan(stream.indexOf("event: done"));

    await manager.stopAll();
    const lookup = createApp({ secret, accounts: "*", bots: restarted });
    const listed = await (await lookup(new Request(url, { headers }))).json();
    expect(listed.activity).toEqual(activity);
    expect(listed.messages.map(({ role, text }: { role: string; text: string }) => [role, text])).toEqual([["user", "ping"], ["bot", "pong"]]);

    const journal = readFileSync(join(restarted.forOwner(owner).layout.dataDir, "history.json"), "utf8");
    expect(journal).not.toContain(hidden);
    expect(JSON.parse(journal).batches.filter(({ record }: { record: { type: string } }) => record.type === "activity")
      .map(({ record }: { record: unknown }) => record)).toEqual(activity);
  } finally {
    await restarted.stopAll();
    await manager.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
