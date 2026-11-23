// TC-3933: a bot that has never had an archive grant keeps no history journal. The journal used to grow until it filled
// (about 3.9 MiB of use), then failed every turn and blocked New chat, the sweep and deletion for good.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Bot, BotManager, type ErrorCode, type Sandbox, type SandboxLauncher, type TurnSink } from "../bot";
import { HistoryJournal } from "../history";
import { botLayout } from "../layout";
import { botIdFor } from "../owner";
import type { Frame } from "../rpc";

/** Run by the sandbox when a prompt arrives, so a test can act in the middle of a turn. */
let duringTurn: (() => Promise<void>) | undefined;
afterEach(() => { duringTurn = undefined; });

class FakeSandbox implements Sandbox {
  readonly #listeners = new Set<(frame: Frame) => void>();
  readonly #exit = Promise.withResolvers<void>();
  readonly exited = this.#exit.promise;
  #seq = 0;
  nextId(): string { return `p-${++this.#seq}`; }
  async request(command: Record<string, unknown>): Promise<unknown> {
    if (command.type === "prompt") {
      await duringTurn?.();
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
  return { manager: managerOn(roots), roots, managerOn };
}

function managerOn(roots: { dataRoot: string; runRoot: string; egressRoot: string }) {
  const launcher: SandboxLauncher = {
    hasState: () => false, leftover: () => false, mountPoints: () => [],
    launch: async () => new FakeSandbox(),
  };
  return new BotManager(launcher, roots, { idleMs: 60_000, turnTimeoutMs: 5_000, maxTurnBytes: MAX_TURN_BYTES, history: HISTORY }, 4);
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

  test("a sibling past the old cap still works, and its old journal is kept", async () => {
    const { manager } = setup();
    const sibling = manager.forBot(OWNER, KEY);
    filled(sibling.layout, false);
    expect(existsSync(journalOf(sibling.layout))).toBe(true);
    expect(await turn(sibling)).toBe("done");
    expect(existsSync(journalOf(sibling.layout))).toBe(true);
    expect(spy.mock.calls.some(call => String(call[0]).includes("history_full"))).toBe(false);
  });

  test("the sweep keeps the journal of an idle bot", () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    filled(main.layout, false);
    return manager.sweepUnused(30 * DAY).then(() => expect(existsSync(journalOf(main.layout))).toBe(true));
  });

  test("New chat deletes its state at once, the journal included", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    filled(main.layout, false);
    writeFileSync(main.layout.stateSnapshot, "notes");
    expect(await manager.deleteWorkingState(botIdFor(OWNER), "new_chat")).toBeUndefined();
    expect(existsSync(main.layout.dataDir)).toBe(false);
  });

  test("the unused sweep keeps it", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    filled(main.layout, false);
    writeFileSync(main.layout.stateSnapshot, "notes");
    await manager.sweepUnused(30 * DAY, Date.now() + 31 * DAY);
    expect(existsSync(main.layout.dataDir)).toBe(true);
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

  test("a journal that holds a receipt counts as granted, so it is kept even with no grant on record", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    const journal = new HistoryJournal(main.layout, HISTORY);
    journal.begin(OWNER, 0);
    journal.append({ type: "user", text: "archived long ago" });
    const state = JSON.parse(readFileSync(journalOf(main.layout), "utf8"));
    state.receipts = [{ body: {}, signature: "0x" }];
    writeFileSync(journalOf(main.layout), JSON.stringify(state));
    expect(new HistoryJournal(main.layout, HISTORY).everGranted).toBe(true);
    await manager.sweepUnused(30 * DAY);
    expect(existsSync(journalOf(main.layout))).toBe(true);
    expect(await turn(main, "next")).toBe("done");
    expect(new HistoryJournal(main.layout, HISTORY).messages().map(message => message.text)).toEqual(["archived long ago", "next", ""]);
  });

  test("a grant that arrives in the middle of a turn on a bot that began it without one does not fail the turn", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    duringTurn = () => main.historyPermission(OWNER, undefined, Date.now() + DAY);
    expect(await turn(main, "granted while it ran")).toBe("done");
    duringTurn = undefined;
    // The turn began before the grant, so it is not archived; the next one is.
    expect(await turn(main, "after")).toBe("done");
    expect(new HistoryJournal(main.layout, HISTORY).messages().map(message => message.text)).toContain("after");
  });

  test("a sibling's grant sent again after a restart of the service is what makes its first turn journal", async () => {
    const { manager, roots, managerOn } = setup();
    await manager.forBot(OWNER, KEY).historyPermission(OWNER, undefined, Date.now() + DAY);
    // The service restarts before the sibling has run: the grant was held in memory only.
    const restarted = managerOn(roots);
    const sibling = restarted.forBot(OWNER, KEY);
    expect(await turn(sibling, "before the grant is sent again")).toBe("done");
    expect(existsSync(journalOf(sibling.layout))).toBe(false);
    // The backend's drain sends the grant again.
    await sibling.historyPermission(OWNER, undefined, Date.now() + DAY);
    expect(await turn(sibling, "after")).toBe("done");
    expect(new HistoryJournal(sibling.layout, HISTORY).messages().map(message => message.text)).toContain("after");
    // Once the sibling has a journal the grant is on disk and survives the next restart.
    const again = managerOn(roots).forBot(OWNER, KEY);
    expect(await turn(again, "later")).toBe("done");
    expect(new HistoryJournal(again.layout, HISTORY).messages().map(message => message.text)).toContain("later");
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

test("a stale extend cannot resume a revoked grant after a restart", async () => {
  const { manager, roots, managerOn } = setup();
  const main = manager.forOwner(OWNER);
  const grant = { cid: "grant-a", revision: 1 };
  const validUntil = Date.now() + DAY;
  await main.historyPermission(OWNER, undefined, validUntil, { ...grant, kind: "extend" });
  expect(await turn(main, "kept")).toBe("done");
  await main.historyPermission(OWNER, Date.now(), undefined, { ...grant, kind: "revoke" });

  const restarted = managerOn(roots).forOwner(OWNER);
  await restarted.historyPermission(OWNER, undefined, validUntil, { ...grant, kind: "extend" });
  expect(await turn(restarted, "outside the grant")).toBe("done");
  const journal = new HistoryJournal(restarted.layout, HISTORY);
  expect(journal.notice()).toBeDefined();
  expect(journal.messages().filter(message => message.role === "user").map(message => message.text)).toEqual(["kept"]);
});

test("an older generation's extend cannot shorten the current grant", async () => {
  const { manager } = setup();
  const main = manager.forOwner(OWNER);
  const validUntil = Date.now() + DAY;
  const current = { kind: "extend" as const, cid: "grant-b", revision: 2 };
  await main.historyPermission(OWNER, undefined, validUntil, current);
  await main.historyPermission(OWNER, undefined, validUntil - 1000, { kind: "extend", cid: "grant-a", revision: 1 });
  await main.historyPermission(OWNER, undefined, validUntil - 500, current);
  expect(new HistoryJournal(main.layout, HISTORY).permission).toEqual({ grant: current, validUntil });
});

test("a revoke for another CID or generation leaves the current grant active", async () => {
  const { manager } = setup();
  const sibling = manager.forBot(OWNER, KEY);
  const current = { kind: "extend" as const, cid: "grant-b", revision: 2 };
  const validUntil = Date.now() + DAY;
  await sibling.historyPermission(OWNER, undefined, validUntil, current);
  await sibling.historyPermission(OWNER, Date.now(), undefined, { kind: "revoke", cid: "grant-a", revision: 2 });
  await sibling.historyPermission(OWNER, Date.now(), undefined, { kind: "revoke", cid: current.cid, revision: 1 });
  expect(existsSync(journalOf(sibling.layout))).toBe(false);
  expect(await turn(sibling, "current grant")).toBe("done");
  const journal = new HistoryJournal(sibling.layout, HISTORY);
  expect(journal.permission).toEqual({ grant: current, validUntil });
  expect(journal.notice()).toBeUndefined();
});

test("a never-run sibling rejects its revoked grant across restarts and accepts a newer grant", async () => {
  const { manager, roots, managerOn } = setup();
  const sibling = manager.forBot(OWNER, KEY);
  const grant = { cid: "grant-a", revision: 1 };
  const validUntil = Date.now() + DAY;
  await sibling.historyPermission(OWNER, undefined, validUntil, { ...grant, kind: "extend" });
  await sibling.historyPermission(OWNER, Date.now(), undefined, { ...grant, kind: "revoke" });
  expect(existsSync(sibling.layout.dataDir)).toBe(false);

  const restarted = managerOn(roots).forBot(OWNER, KEY);
  await restarted.historyPermission(OWNER, undefined, validUntil, { ...grant, kind: "extend" });
  await restarted.historyPermission(OWNER, undefined, validUntil);
  expect(await turn(restarted, "outside the grant")).toBe("done");
  expect(existsSync(journalOf(restarted.layout))).toBe(false);

  const newer = { cid: "grant-b", revision: 2, kind: "extend" as const };
  await restarted.historyPermission(OWNER, undefined, validUntil, newer);
  await restarted.historyPermission(OWNER, Date.now(), undefined, { ...grant, kind: "revoke" });
  expect(await turn(restarted, "covered by the new grant")).toBe("done");
  const journal = new HistoryJournal(restarted.layout, HISTORY);
  expect(journal.permission?.grant).toEqual(newer);
  expect(journal.messages().filter(message => message.role === "user").map(message => message.text))
    .toEqual(["covered by the new grant"]);
});

test.each([false, true])("a revoke after restart blocks a delayed extend (older revoke on disk: %s)", async olderRevoked => {
  const { manager, roots, managerOn } = setup();
  const sibling = manager.forBot(OWNER, KEY);
  const validUntil = Date.now() + DAY;
  if (olderRevoked) {
    const older = { cid: "grant-a", revision: 1 };
    await sibling.historyPermission(OWNER, undefined, validUntil, { ...older, kind: "extend" });
    await sibling.historyPermission(OWNER, Date.now(), undefined, { ...older, kind: "revoke" });
  }
  const grant = { cid: "grant-b", revision: 2 };
  await sibling.historyPermission(OWNER, undefined, validUntil, { ...grant, kind: "extend" });
  await managerOn(roots).forBot(OWNER, KEY).historyPermission(OWNER, Date.now(), undefined, { ...grant, kind: "revoke" });

  const restarted = managerOn(roots).forBot(OWNER, KEY);
  await restarted.historyPermission(OWNER, undefined, validUntil, { ...grant, kind: "extend" });
  expect(await turn(restarted, "outside the grant")).toBe("done");
  expect(existsSync(journalOf(restarted.layout))).toBe(false);
});
