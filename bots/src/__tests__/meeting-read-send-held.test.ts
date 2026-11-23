// TC-3792: the owner's Send on a proposal card while the chat holds the owner's meeting data. The supervisor refuses it
// as `held` before anything is marked sending, so the proposal stays as it is; in a fresh chat the same Send goes on.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionStore, actionBinding } from "../actions";
import { BotManager, type BotMessenger, type SandboxLauncher } from "../bot";
import { botLayout } from "../layout";
import { botIdFor } from "../owner";

const OWNER = `did:pkh:eip155:1:0x${"22".repeat(20)}`;
const FIRST = "a".repeat(32);
const TEXT = "Please send me your status by noon.";

let root: string;
let held: boolean;
let spy: { mockRestore(): void };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "send-held-"));
  held = true;
  spy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  spy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const launcher: SandboxLauncher = {
    hasState: () => false, leftover: () => false, mountPoints: () => [],
    launch: async () => { throw new Error("no sandbox in this test"); },
    readsHeld: async () => held,
    spendAction: async () => false,
  };
  const bots = new BotManager(launcher, roots, { idleMs: 60_000, turnTimeoutMs: 4_000, maxTurnBytes: 64_000 }, 3);
  const mainId = botIdFor(OWNER);
  const layout = botLayout(mainId, roots);
  const payload = { kind: "message_bots" as const, targets: [FIRST], text: TEXT };
  const binding = actionBinding(layout.ownerId, mainId, payload);
  const id = "9c41e0d2a7b3f6c18e5d2a90";
  new ActionStore(layout).ingest([{ id, ...payload, binding, askedAt: Date.now(), outside: false }]);
  const messenger: BotMessenger = { keys: [FIRST], dispatch: async () => ({ text: "unreachable", isError: true as const }) };
  return { bot: bots.forOwner(OWNER), layout, id, binding, messenger, stop: () => bots.stopAll() };
}

test("a Send while the chat holds the owner's data is refused as held and the proposal stays pending", async () => {
  const run = setup();
  try {
    expect(await run.bot.approveRequest(run.id, run.binding, run.messenger)).toEqual({ ok: false, error: "held" });
    expect(new ActionStore(run.layout).list().map(request => request.state)).toEqual(["pending"]);
  } finally { await run.stop(); }
});

test("in a fresh chat the same Send goes on", async () => {
  held = false;
  const run = setup();
  try {
    const result = await run.bot.approveRequest(run.id, run.binding, run.messenger);
    expect(result.ok).toBe(true);
  } finally { await run.stop(); }
});
