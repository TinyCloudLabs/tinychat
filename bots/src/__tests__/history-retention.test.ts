import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotManager, type SandboxLauncher } from "../bot";
import { HistoryJournal } from "../history";
import { botLayout } from "../layout";
import { createHash } from "node:crypto";
import { botIdFor } from "../owner";
const tmp = mkdtempSync(join(tmpdir(), "history-retention-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const day = 86_400_000;
const owner = "did:pkh:eip155:1:0x" + "22".repeat(20);
function setup(delivered: boolean, renewed = false, beforeRemove?: () => void) {
  const root = mkdtempSync(join(tmp, "case-"));
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const layout = botLayout(botIdFor(owner), roots);
  const options = { signerDid: "did:pkh:eip155:1:0x" + "11".repeat(20), host: "https://node.test", policy: "notice-then-expiry-30-days" as const };
  const history = new HistoryJournal(layout, options);
  const expiry = Date.now() - 30 * day - 1000;
  history.permissionExpired(expiry, owner, expiry);
  history.append({ type: "user", text: "uncopied" });
  writeFileSync(layout.stateSnapshot, "notes");
  // A current last-use marker must not postpone the separately approved permission-expiry deadline.
  writeFileSync(layout.lastUsedFile, new Date().toISOString());
  if (delivered) history.acknowledgeNotice(history.notice()!.id, expiry, expiry);
  if (renewed) history.permissionActive(Date.now() + day);
  const launcher: SandboxLauncher = { hasState: () => true, leftover: () => false, mountPoints: () => { beforeRemove?.(); return []; }, launch: async () => { throw new Error("not used"); } };
  const manager = new BotManager(launcher, roots, { idleMs: 1000, turnTimeoutMs: 1000, maxTurnBytes: 1000, history: options }, 1);
  return { manager, layout };
}
test("the real retention sweep keeps expired uncopied history until the notice was rendered", async () => {
  const { manager, layout } = setup(false);
  await manager.sweepUnused(30 * day);
  await manager.deleteWorkingState(botIdFor(owner), "unused");
  expect(existsSync(layout.dataDir)).toBe(true);
});
test("the real retention sweep deletes uncopied history at the acknowledged expiry deadline", async () => {
  const { manager, layout } = setup(true);
  await manager.sweepUnused(30 * day);
  expect(existsSync(layout.dataDir)).toBe(false);
});
test("renewed permission cancels the expiry sweep and keeps uncopied records for the resumed writer", async () => {
  const { manager, layout } = setup(true, true);
  await manager.sweepUnused(30 * day);
  expect(existsSync(layout.dataDir)).toBe(true);
  expect((await manager.forOwner(owner).historyPending())?.record).toEqual({ type: "user", text: "uncopied" });
});

test("a late staging operation waits for retention and cannot recreate deleted history", async () => {
  let stage: Promise<void> | undefined;
  let error: string | undefined;
  const { manager, layout } = setup(true, false, () => queueMicrotask(() => late()));
  const bot = manager.forOwner(owner);
  const batch = (await bot.historyPending())!;
  const late = () => { stage = bot.historyStage({ seq: batch.seq, challenge: batch.challenge,
    batchHash: createHash("sha256").update(JSON.stringify(batch)).digest("hex"), envelope: { fixture: true } }).catch(e => { error = e.message; }); };
  await manager.deleteWorkingState(botIdFor(owner), "permission_expired");
  await stage;
  expect(error).toBe("history_stage_mismatch");
  expect(existsSync(layout.dataDir)).toBe(false);
});
