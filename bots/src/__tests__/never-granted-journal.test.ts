// TC-3933: a bot that has never had an archive grant keeps no history journal. The journal used to grow until it filled
// (about 3.9 MiB of use), then failed every turn and blocked New chat, the sweep and deletion for good.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Bot, BotManager, type ErrorCode, type Sandbox, type SandboxLauncher, type TurnSink } from "../bot";
import { HistoryJournal } from "../history";
import { botLayout } from "../layout";
import { botIdFor } from "../owner";
import type { Frame } from "../rpc";

class FakeSandbox implements Sandbox {
  readonly #listeners = new Set<(frame: Frame) => void>();
  readonly #exit = Promise.withResolvers<void>();
  readonly exited = this.#exit.promise;
  #seq = 0;
  nextId(): string { return `p-${++this.#seq}`; }
  async request(command: Record<string, unknown>): Promise<unknown> {
    if (command.type === "prompt") {
      const id = command.id as string;
      queueMicrotask(() => { for (const listener of this.#listeners) listener({ type: "prompt_result", id, status: "completed", agentInvoked: true, sessionSettled: true }); });
    }
    return { agentInvoked: true };
  }
  onFrame(listener: (frame: Frame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async refreshEgress(): Promise<void> {}
  async snapshot(): Promise<void> {}
  async stop(): Promise<void> { this.#exit.resolve(); }
}

const DAY = 86_400_000;
const MIB = 1024 * 1024;
const OWNER = "did:pkh:eip155:1:0x" + "22".repeat(20);
const KEY = "ab".repeat(16);
const HISTORY = { signerDid: "did:pkh:eip155:1:0x" + "11".repeat(20), host: "https://node.test", policy: "notice-then-expiry-30-days" as const };
const MAX_TURN_BYTES = 1024;
const RESERVE = MAX_TURN_BYTES * 16 + 128 * 1024;

const tmp = mkdtempSync(join(tmpdir(), "never-granted-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function setup() {
  const root = mkdtempSync(join(tmp, "case-"));
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const launcher: SandboxLauncher = {
    hasState: () => false, leftover: () => false, mountPoints: () => [],
    launch: async () => new FakeSandbox(),
  };
  const manager = new BotManager(launcher, roots, { idleMs: 60_000, turnTimeoutMs: 5_000, maxTurnBytes: MAX_TURN_BYTES, history: HISTORY }, 4);
  return { manager, roots };
}

async function turn(bot: Bot, text = "hello", owner = OWNER) {
  const events: Array<[string, unknown]> = [];
  const sink: TurnSink = {
    status: state => events.push(["status", state]),
    delta: delta => events.push(["delta", delta]),
    done: id => events.push(["done", id]),
    error: (code: ErrorCode) => events.push(["error", code]),
  };
  await bot.send(text, sink, owner);
  return events.at(-1)![0] === "done" ? "done" : String(events.at(-1)![1]);
}

/** A journal filled to just under the cap, so the old reserve check refuses the next turn. */
function filled(layout: ReturnType<typeof botLayout>, grant: boolean) {
  const journal = new HistoryJournal(layout, HISTORY);
  journal.begin(OWNER, 0);
  if (grant) journal.permissionActive(Date.now() + DAY);
  for (let i = 0; i < 7; i++) journal.append({ type: "user", text: "x".repeat(MIB) });
  journal.append({ type: "user", text: "y".repeat(MIB - 80 * 1024) });
  expect(() => new HistoryJournal(layout, HISTORY).begin(OWNER, RESERVE)).toThrow("history_full");
}

const journalOf = (layout: ReturnType<typeof botLayout>) => join(layout.dataDir, "history.json");

let spy: { mockRestore(): void; mock: { calls: unknown[][] } };
beforeEach(() => { spy = spyOn(console, "log").mockImplementation(() => {}) as never; });
afterEach(() => spy.mockRestore());

describe("a bot that never had a grant", () => {
  test("keeps no journal, however many turns it takes", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    for (let i = 0; i < 3; i++) expect(await turn(main, `message ${i}`)).toBe("done");
    expect(existsSync(journalOf(main.layout))).toBe(false);
    const sibling = manager.forBot(OWNER, KEY);
    expect(await turn(sibling)).toBe("done");
    expect(existsSync(journalOf(sibling.layout))).toBe(false);
  });

  test("a sibling past the old cap still works, and the old journal is dropped on the turn", async () => {
    const { manager } = setup();
    const sibling = manager.forBot(OWNER, KEY);
    filled(sibling.layout, false);
    expect(existsSync(journalOf(sibling.layout))).toBe(true);
    expect(await turn(sibling)).toBe("done");
    expect(existsSync(journalOf(sibling.layout))).toBe(false);
    expect(spy.mock.calls.some(call => String(call[0]).includes("history_full"))).toBe(false);
  });

  test("the sweep drops the journal of an idle bot that no turn will reach", () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    filled(main.layout, false);
    return manager.sweepUnused(30 * DAY).then(() => expect(existsSync(journalOf(main.layout))).toBe(false));
  });

  test("New chat deletes its state at once, the journal included", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    filled(main.layout, false);
    writeFileSync(main.layout.stateSnapshot, "notes");
    expect(await manager.deleteWorkingState(botIdFor(OWNER), "new_chat")).toBeUndefined();
    expect(existsSync(main.layout.dataDir)).toBe(false);
  });

  test("the unused sweep deletes it", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    filled(main.layout, false);
    writeFileSync(main.layout.stateSnapshot, "notes");
    await manager.sweepUnused(30 * DAY, Date.now() + 31 * DAY);
    expect(existsSync(main.layout.dataDir)).toBe(false);
  });

  test("deleting a sibling goes ahead", async () => {
    const { manager } = setup();
    const sibling = manager.forBot(OWNER, KEY);
    filled(sibling.layout, false);
    expect(await manager.deleteBot(OWNER, KEY)).toBeUndefined();
    expect(existsSync(sibling.layout.dataDir)).toBe(false);
  });
});

describe("a bot that has a grant", () => {
  test("journals from the grant on, and its uncovered journal still holds New chat as archive_pending", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    expect(await turn(main, "before the grant")).toBe("done");
    expect(existsSync(journalOf(main.layout))).toBe(false);

    await main.historyPermission(OWNER, undefined, Date.now() + DAY);
    expect(await turn(main, "after the grant")).toBe("done");
    const texts = new HistoryJournal(main.layout, HISTORY).messages().map(message => message.text);
    expect(texts).toContain("after the grant");
    expect(texts).not.toContain("before the grant");

    expect(await manager.deleteWorkingState(botIdFor(OWNER), "new_chat")).toBe("archive_pending");
    expect(existsSync(journalOf(main.layout))).toBe(true);
  });

  test("the first grant clears what the bot held before it, so New chat is not locked after a late approval", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    expect(await turn(main, "chatted before approving")).toBe("done");
    mkdirSync(main.layout.dataDir, { recursive: true });
    writeFileSync(main.layout.stateSnapshot, "notes from before the grant");
    await main.historyPermission(OWNER, undefined, Date.now() + DAY);
    expect(new HistoryJournal(main.layout, HISTORY).legacyPending).toBe(false);
    expect(await manager.deleteWorkingState(botIdFor(OWNER), "new_chat")).toBeUndefined();
    expect(existsSync(main.layout.dataDir)).toBe(false);
  });

  test("a sibling that was granted before it ran journals from its first turn", async () => {
    const { manager } = setup();
    const sibling = manager.forBot(OWNER, KEY);
    await sibling.historyPermission(OWNER, undefined, Date.now() + DAY);
    expect(existsSync(sibling.layout.dataDir)).toBe(false);
    expect(await turn(sibling, "first")).toBe("done");
    const journal = new HistoryJournal(sibling.layout, HISTORY);
    expect(journal.everGranted).toBe(true);
    expect(journal.messages().map(message => message.text)).toContain("first");
  });

  test("a journal that reaches the cap fails the turn and logs history_full", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    filled(main.layout, true);
    expect(await turn(main)).toBe("bot_unavailable");
    expect(spy.mock.calls.some(call => String(call[0]).includes('"bots":"history_full"'))).toBe(true);
  });

  test("a journal with an expired grant on record keeps journaling, since the archive is still owed", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    const journal = new HistoryJournal(main.layout, HISTORY);
    const expiry = Date.now() - 1000;
    journal.permissionExpired(expiry, OWNER, expiry + 500);
    journal.append({ type: "user", text: "owed" });
    expect(await turn(main, "next")).toBe("done");
    expect(new HistoryJournal(main.layout, HISTORY).messages().map(message => message.text)).toEqual(expect.arrayContaining(["owed", "next"]));
  });
});
