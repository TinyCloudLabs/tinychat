// The owner's Send authorizes only the proposal they saw, including in a chat
// that read private data. Its approval must be spent before anything is delivered.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionStore } from "../actions";
import { ActionDesk } from "../actions-desk";
import { utcDay } from "../asks";
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

function setup(spendable = true) {
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const mainId = botIdFor(OWNER);
  const desk = new ActionDesk(Date.now, () => mainId, () => false);
  desk.push(mainId, { keys: [FIRST], pending: 0, day: utcDay(Date.now()), today: 0, final: [] });
  desk.call(mainId, { kind: "message_bots", targets: [FIRST], text: TEXT });
  const [proposal] = desk.drain(mainId);
  expect(proposal).toBeDefined();
  const launcher: SandboxLauncher = {
    hasState: () => false, leftover: () => false, mountPoints: () => [],
    launch: async () => { throw new Error("no sandbox in this test"); },
    readsHeld: async () => held,
    spendAction: async (layout, id, binding) => spendable && desk.spend(layout.botId, id, binding),
  };
  const bots = new BotManager(launcher, roots, { idleMs: 60_000, turnTimeoutMs: 4_000, maxTurnBytes: 64_000 }, 3);
  const layout = botLayout(mainId, roots);
  new ActionStore(layout).ingest([proposal!]);
  const deliveries: Array<{ key: string; text: string }> = [];
  const messenger: BotMessenger = { keys: [FIRST], dispatch: async (key, text) => {
    deliveries.push({ key, text });
    return { text: "Delivered" };
  } };
  return { bot: bots.forOwner(OWNER), layout, id: proposal!.id, binding: proposal!.binding, messenger, deliveries, stop: () => bots.stopAll() };
}

test("an owner-approved Send from a private chat delivers the exact proposal once", async () => {
  const run = setup();
  try {
    expect(run.deliveries).toEqual([]);
    expect(new ActionStore(run.layout).list().map(request => request.state)).toEqual(["pending"]);
    expect((await run.bot.approveRequest(run.id, run.binding, run.messenger)).ok).toBe(true);
    await Bun.sleep(0);
    expect(run.deliveries).toEqual([{ key: FIRST, text: TEXT }]);
    expect(await run.bot.approveRequest(run.id, run.binding, run.messenger)).toEqual({ ok: false, error: "not_pending" });
    expect(new ActionStore(run.layout).list()[0]!.outcomes).toEqual([{ key: FIRST, delivered: true }]);
    expect(await run.bot.holdsOwnerData()).toBe(true);
  } finally { await run.stop(); }
});

test("a changed binding does not approve or send a private proposal", async () => {
  const run = setup();
  try {
    expect(await run.bot.approveRequest(run.id, "0".repeat(64), run.messenger)).toEqual({ ok: false, error: "invalid" });
    expect(run.deliveries).toEqual([]);
    expect(new ActionStore(run.layout).list()[0]!.state).toBe("pending");
  } finally { await run.stop(); }
});

test("an approval the gateway cannot spend sends nothing", async () => {
  const run = setup(false);
  try {
    expect((await run.bot.approveRequest(run.id, run.binding, run.messenger)).ok).toBe(true);
    await Bun.sleep(0);
    expect(run.deliveries).toEqual([]);
    expect(new ActionStore(run.layout).list()[0]!.outcomes).toEqual([{ key: FIRST, delivered: false }]);
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
