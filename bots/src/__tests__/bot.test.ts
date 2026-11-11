import { afterAll, describe, expect, jest, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot, BotManager, type ErrorCode, type Sandbox, type SandboxLauncher, type TurnSink } from "../bot";
import { type BotLayout, botLayout, type LayoutRoots } from "../layout";
import { botIdFor } from "../owner";
import type { Frame } from "../rpc";

const tmp = mkdtempSync(join(tmpdir(), "bots-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Empty data, run and egress roots of their own under the test's temp directory. */
function roots(): LayoutRoots {
  const dir = mkdtempSync(join(tmp, "roots-"));
  return { dataRoot: join(dir, "data"), runRoot: join(dir, "run"), egressRoot: join(dir, "egress") };
}

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
const OPTIONS = { idleMs: 60_000, turnTimeoutMs: 300_000, maxTurnBytes: 16 };

function setup() {
  const sandbox = new FakeSandbox();
  const launcher: SandboxLauncher = {
    hasState: () => true,
    launch: async layout => {
      mkdirSync(layout.dataDir, { recursive: true });
      return sandbox;
    },
  };
  const bot = new Bot(botLayout("c".repeat(64), roots()), launcher, OPTIONS);
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

  test("a reply past the per-turn byte cap aborts the agent's turn and ends with an error", async () => {
    const { bot, sandbox } = setup();
    const { events, sink } = recorder();
    const running = bot.send("hi", sink);
    await sandbox.prompted.promise;
    sandbox.emit(delta("0123456789"));
    sandbox.emit(delta("0123456789"));
    sandbox.emit(delta("never sent"));
    await running;
    expect(events.slice(2)).toEqual([
      ["delta", "0123456789"],
      ["error", "bot_unavailable"],
    ]);
    expect(sandbox.commands.at(-1)).toEqual({ type: "abort" });
  });

  test("a turn with no prompt_result by the deadline ends with an error and its sandbox is stopped", async () => {
    jest.useFakeTimers();
    try {
      const { bot, sandbox } = setup();
      const { events, sink } = recorder();
      const running = bot.send("hi", sink);
      await sandbox.prompted.promise;
      jest.advanceTimersByTime(OPTIONS.turnTimeoutMs + 1);
      await running;
      await sandbox.exited;
      expect(events.at(-1)).toEqual(["error", "bot_unavailable"]);
    } finally {
      jest.useRealTimers();
    }
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
    const bot = new Bot(botLayout("d".repeat(64), { dataRoot: "/d", runRoot: "/r", egressRoot: "/e" }), launcher, OPTIONS);
    expect(await bot.list()).toEqual([]);
    expect(launched).toBe(false);
  });
});

describe("working state retention", () => {
  const DAY = 24 * 60 * 60_000;
  const RETENTION = 30 * DAY;
  const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
  const OTHER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb";

  /** A manager over temp roots whose launches act on disk like RunscHost: the first creates the state image. */
  function host() {
    const dirs = roots();
    const fake = { launches: 0, next: new FakeSandbox(), hold: Promise.resolve() };
    const launcher: SandboxLauncher = {
      hasState: layout => existsSync(layout.stateImage),
      launch: async layout => {
        await fake.hold;
        fake.launches++;
        mkdirSync(layout.stateMount, { recursive: true });
        mkdirSync(layout.dataDir, { recursive: true });
        if (!existsSync(layout.stateImage)) writeFileSync(layout.stateImage, "fresh");
        const sandbox = fake.next;
        fake.next = new FakeSandbox();
        return sandbox;
      },
    };
    const manager = new BotManager(launcher, dirs, OPTIONS);
    return { fake, dirs, manager, layout: (owner: string) => botLayout(botIdFor(owner), dirs) };
  }

  /** A stopped bot that has run before: old notes in its state image, and a marker unless `usedAt` is null. */
  function existing(layout: BotLayout, usedAt: number | null, imageAt = usedAt ?? Date.now()) {
    mkdirSync(layout.dataDir, { recursive: true });
    writeFileSync(layout.stateImage, "old notes");
    utimesSync(layout.stateImage, imageAt / 1000, imageAt / 1000);
    if (usedAt !== null) writeFileSync(layout.lastUsedFile, new Date(usedAt).toISOString());
  }

  /** Sends one message and completes its turn. */
  async function converse(bot: Bot, sandbox: FakeSandbox) {
    const { events, sink } = recorder();
    const running = bot.send("hi", sink);
    const id = await sandbox.prompted.promise;
    sandbox.emit({ type: "prompt_result", id, status: "completed", agentInvoked: true, sessionSettled: true });
    await running;
    return events;
  }

  test("a sweep deletes a bot unused for longer than the retention and keeps a recently used one", async () => {
    const { fake, manager, layout } = host();
    const sandbox = fake.next;
    await converse(manager.forOwner(OWNER), sandbox);
    expect(existsSync(layout(OWNER).lastUsedFile)).toBe(true);
    const later = Date.now() + RETENTION + DAY;
    existing(layout(OTHER), later - DAY);
    await manager.sweepUnused(RETENTION, later);
    expect(Bun.peek.status(sandbox.exited)).toBe("fulfilled");
    expect(existsSync(layout(OWNER).dataDir)).toBe(false);
    expect(existsSync(layout(OWNER).bundleDir)).toBe(false);
    expect(readFileSync(layout(OTHER).stateImage, "utf8")).toBe("old notes");
  });

  test("a bot with a turn in flight is not deleted", async () => {
    const { fake, manager, layout } = host();
    const sandbox = fake.next;
    const { events, sink } = recorder();
    const running = manager.forOwner(OWNER).send("hi", sink);
    const id = await sandbox.prompted.promise;
    await manager.sweepUnused(RETENTION, Date.now() + RETENTION + DAY);
    expect(existsSync(layout(OWNER).stateImage)).toBe(true);
    sandbox.emit({ type: "prompt_result", id, status: "completed", agentInvoked: true, sessionSettled: true });
    await running;
    expect(events.at(-1)?.[0]).toBe("done");
  });

  test("a bot whose sandbox is still starting for a request is not deleted", async () => {
    const { fake, manager, layout } = host();
    existing(layout(OWNER), Date.now() - RETENTION - DAY);
    const launched = Promise.withResolvers<void>();
    fake.hold = launched.promise;
    const replying = converse(manager.forOwner(OWNER), fake.next);
    await manager.sweepUnused(RETENTION);
    expect(readFileSync(layout(OWNER).stateImage, "utf8")).toBe("old notes");
    launched.resolve();
    expect((await replying).at(-1)?.[0]).toBe("done");
  });

  test("a message that arrives during deletion waits for it, then starts a fresh bot", async () => {
    const { fake, manager, layout } = host();
    const bot = manager.forOwner(OWNER);
    await converse(bot, fake.next);
    writeFileSync(layout(OWNER).stateImage, "old notes");
    const sweeping = manager.sweepUnused(RETENTION, Date.now() + RETENTION + DAY);
    const replying = converse(bot, fake.next);
    await sweeping;
    expect(await replying).toEqual([
      ["status", "starting"],
      ["status", "working"],
      ["done", expect.stringMatching(/^b-\d+$/)],
    ]);
    // Launched only once the old state was gone: a launch before the removal would have kept the old notes or
    // had its own state image removed.
    expect(fake.launches).toBe(2);
    expect(readFileSync(layout(OWNER).stateImage, "utf8")).toBe("fresh");
    expect(existsSync(layout(OWNER).lastUsedFile)).toBe(true);
  });

  test("a bot without a marker counts from its state image's mtime", async () => {
    const { manager, layout } = host();
    const now = Date.now();
    existing(layout(OWNER), null, now - RETENTION - DAY);
    existing(layout(OTHER), null, now - DAY);
    await manager.sweepUnused(RETENTION, now);
    expect(existsSync(layout(OWNER).dataDir)).toBe(false);
    expect(readFileSync(layout(OTHER).stateImage, "utf8")).toBe("old notes");
  });

  test("entries in the data root that are not bot ids are left alone", async () => {
    const { dirs, manager } = host();
    const old = (Date.now() - RETENTION - DAY) / 1000;
    const names = ["lost+found", "A".repeat(64), "a".repeat(63), `${"a".repeat(64)}.old`];
    for (const name of names) {
      mkdirSync(join(dirs.dataRoot, name), { recursive: true });
      writeFileSync(join(dirs.dataRoot, name, "state.img"), "x");
      utimesSync(join(dirs.dataRoot, name, "state.img"), old, old);
    }
    await manager.sweepUnused(RETENTION);
    for (const name of names) expect(existsSync(join(dirs.dataRoot, name, "state.img"))).toBe(true);
  });
});
