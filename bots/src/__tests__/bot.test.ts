import { describe, expect, test } from "bun:test";
import { Bot, type ErrorCode, type Sandbox, type SandboxLauncher, type TurnSink } from "../bot";
import { botLayout } from "../layout";
import type { Frame } from "../rpc";

/** Stands in for OMP behind the RPC channel: records commands and lets the test emit frames. */
class FakeSandbox implements Sandbox {
  readonly commands: Record<string, unknown>[] = [];
  readonly #listeners = new Set<(frame: Frame) => void>();
  readonly #exit = Promise.withResolvers<void>();
  readonly exited = this.#exit.promise;
  readonly prompted = Promise.withResolvers<string>();
  #seq = 0;

  nextId(): string {
    return `p-${++this.#seq}`;
  }
  async request(command: Record<string, unknown>): Promise<unknown> {
    this.commands.push(command);
    if (command.type === "prompt") this.prompted.resolve(command.id as string);
    return { agentInvoked: true };
  }
  onFrame(listener: (frame: Frame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(frame: Frame): void {
    for (const listener of this.#listeners) listener(frame);
  }
  async refreshEgress(): Promise<void> {}
  async stop(): Promise<void> {
    this.#exit.resolve();
  }
}

function recorder() {
  const events: Array<[string, unknown]> = [];
  const sink: TurnSink = {
    status: state => events.push(["status", state]),
    delta: text => events.push(["delta", text]),
    done: messageId => events.push(["done", messageId]),
    error: (code: ErrorCode) => events.push(["error", code]),
  };
  return { events, sink };
}

function setup() {
  const sandbox = new FakeSandbox();
  const launcher: SandboxLauncher = { hasState: () => true, launch: async () => sandbox };
  const bot = new Bot(botLayout("c".repeat(64), { dataRoot: "/d", runRoot: "/r", egressRoot: "/e" }), launcher, 60_000);
  return { bot, sandbox };
}

const delta = (text: string, role = "assistant"): Frame => ({
  type: "message_update",
  message: { role },
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
});

describe("one message at a time", () => {
  test("a second send while one runs gets busy; the first still completes", async () => {
    const { bot, sandbox } = setup();
    const first = recorder();
    const second = recorder();
    const running = bot.send("one", first.sink);
    const id = await sandbox.prompted.promise;
    await bot.send("two", second.sink);
    expect(second.events).toEqual([["error", "busy"]]);
    sandbox.emit({ type: "prompt_result", id, status: "completed", agentInvoked: true, sessionSettled: true });
    await running;
    expect(first.events.at(-1)?.[0]).toBe("done");
    expect(sandbox.commands.filter(command => command.type === "prompt")).toHaveLength(1);
  });
});

describe("turn events", () => {
  test("assistant text deltas stream, the done id matches the listed reply, other frames are ignored", async () => {
    const { bot, sandbox } = setup();
    const { events, sink } = recorder();
    const running = bot.send("hi", sink);
    const id = await sandbox.prompted.promise;
    sandbox.emit(delta("po"));
    sandbox.emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
    sandbox.emit(delta("ignored", "user"));
    sandbox.emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: 42 } });
    sandbox.emit(delta("ng"));
    sandbox.emit({ type: "message_end", message: { role: "assistant", timestamp: 1_700_000_000_123 } });
    sandbox.emit(delta("again"));
    sandbox.emit({ type: "prompt_result", id: "someone-else", status: "error" });
    sandbox.emit({ type: "prompt_result", id, status: "completed", agentInvoked: true, sessionSettled: true });
    await running;
    expect(events).toEqual([
      ["status", "starting"],
      ["status", "working"],
      ["delta", "po"],
      ["delta", "ng"],
      ["delta", "\n\n"],
      ["delta", "again"],
      ["done", "b-1700000000123"],
    ]);
  });

  for (const [status, code] of [
    ["error", "model_unavailable"],
    ["aborted", "bot_unavailable"],
  ] as const) {
    test(`prompt_result ${status} ends with ${code}`, async () => {
      const { bot, sandbox } = setup();
      const { events, sink } = recorder();
      const running = bot.send("hi", sink);
      const id = await sandbox.prompted.promise;
      sandbox.emit({ type: "prompt_result", id, status, error: { message: "raw upstream error text" } });
      await running;
      expect(events.at(-1)).toEqual(["error", code]);
    });
  }

  test("a sandbox that dies mid-turn ends the turn with bot_unavailable", async () => {
    const { bot, sandbox } = setup();
    const { events, sink } = recorder();
    const running = bot.send("hi", sink);
    await sandbox.prompted.promise;
    await sandbox.stop();
    await running;
    expect(events.at(-1)).toEqual(["error", "bot_unavailable"]);
  });
});

describe("history", () => {
  test("lists user messages and merged replies, newest last, ids matching the streamed done id", async () => {
    const { bot, sandbox } = setup();
    sandbox.request = async command => {
      if (command.type !== "get_messages_page") return undefined;
      return {
        totalMessages: 5,
        messages: [
          { role: "user", content: "hi", timestamp: 1_700_000_000_000 },
          { role: "assistant", content: [{ type: "text", text: "po" }, { type: "toolCall", id: "t" }], timestamp: 1_700_000_000_123 },
          { role: "toolResult", content: [{ type: "text", text: "tool output" }], timestamp: 1_700_000_000_200 },
          { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "again" }], timestamp: 1_700_000_000_300 },
          { role: "user", content: [{ type: "text", text: "notice" }], synthetic: true, timestamp: 1_700_000_000_400 },
        ],
      };
    };
    expect(await bot.list()).toEqual([
      { id: "u-1700000000000", role: "user", text: "hi", at: "2023-11-14T22:13:20.000Z" },
      { id: "b-1700000000123", role: "bot", text: "po\n\nagain", at: "2023-11-14T22:13:20.123Z" },
    ]);
  });

  test("a bot that never ran lists nothing and starts no sandbox", async () => {
    let launched = false;
    const launcher: SandboxLauncher = {
      hasState: () => false,
      launch: async () => {
        launched = true;
        return new FakeSandbox();
      },
    };
    const bot = new Bot(botLayout("d".repeat(64), { dataRoot: "/d", runRoot: "/r", egressRoot: "/e" }), launcher, 60_000);
    expect(await bot.list()).toEqual([]);
    expect(launched).toBe(false);
  });
});
