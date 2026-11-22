// TC-3933: the retention sweep never removes the working state of a bot that never had an archive grant, and its existing
// history.json is kept. Only the owner's New chat or deletion does. Fixtures are those of never-granted-journal.test.ts.
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

const swept = (manager: BotManager) => manager.sweepUnused(30 * DAY, Date.now() + 31 * DAY);

describe("a bot that never had a grant, past retention", () => {
  test("keeps its working state and its journal through the sweep, and logs why", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    filled(main.layout, false);
    writeFileSync(main.layout.stateSnapshot, "notes");
    const before = readFileSync(journalOf(main.layout));
    await swept(manager);
    expect(readFileSync(main.layout.stateSnapshot, "utf8")).toBe("notes");
    expect(readFileSync(journalOf(main.layout)).equals(before)).toBe(true);
    expect(spy.mock.calls.some(call => String(call[0]).includes('"cause":"ungranted_retained"'))).toBe(true);
  });

  test("keeps its journal as it is through a turn, which still works and is not journaled", async () => {
    const { manager } = setup();
    const sibling = manager.forBot(OWNER, KEY);
    filled(sibling.layout, false);
    const before = readFileSync(journalOf(sibling.layout));
    expect(await turn(sibling)).toBe("done");
    expect(readFileSync(journalOf(sibling.layout)).equals(before)).toBe(true);
  });

  test("expiry of a permission is no reason to delete it either", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    filled(main.layout, false);
    writeFileSync(main.layout.stateSnapshot, "notes");
    expect(await manager.deleteWorkingState(botIdFor(OWNER), "permission_expired")).toBe("ungranted_retained");
    expect(existsSync(main.layout.dataDir)).toBe(true);
  });

  test("still goes with New chat and with deletion", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    filled(main.layout, false);
    writeFileSync(main.layout.stateSnapshot, "notes");
    expect(await manager.deleteWorkingState(botIdFor(OWNER), "new_chat")).toBeUndefined();
    expect(existsSync(main.layout.dataDir)).toBe(false);
    const sibling = manager.forBot(OWNER, KEY);
    filled(sibling.layout, false);
    expect(await manager.deleteBot(OWNER, KEY)).toBeUndefined();
    expect(existsSync(sibling.layout.dataDir)).toBe(false);
  });

  test("a sibling that never ran makes no journal and no directory under the sweep", async () => {
    const { manager, roots } = setup();
    manager.forBot(OWNER, KEY);
    await swept(manager);
    expect(existsSync(roots.dataRoot)).toBe(false);
  });

  test("a bot with a grant is still swept by the archive's rules: kept while uncovered", async () => {
    const { manager } = setup();
    const main = manager.forOwner(OWNER);
    await main.historyPermission(OWNER, undefined, Date.now() + DAY);
    expect(await turn(main, "granted")).toBe("done");
    expect(await manager.deleteWorkingState(botIdFor(OWNER), "unused")).toBe("archive_pending");
  });
});
