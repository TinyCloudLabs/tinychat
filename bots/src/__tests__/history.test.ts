import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { HistoryJournal } from "../history";
import { botLayout } from "../layout";
import { botIdFor } from "../owner";
const tmp = mkdtempSync(join(tmpdir(), "bot-history-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const account = privateKeyToAccount("0x" + "11".repeat(32) as `0x${string}`);
const owner = "did:pkh:eip155:1:0x" + "22".repeat(20);
const options = { signerDid: `did:pkh:eip155:1:${account.address.toLowerCase()}`, host: "https://node.test", policy: "notice-then-expiry-30-days" as const };
function setup() {
  const root = mkdtempSync(join(tmp, "case-"));
  const layout = botLayout(botIdFor(owner), { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") });
  return { layout, journal: new HistoryJournal(layout, options) };
}
async function receipt(journal: HistoryJournal, change = {}) {
  const batch = journal.pending()!;
  const body = { v: 1, owner, botId: botIdFor(owner), generation: batch.generation, seq: batch.seq,
    challenge: batch.challenge, batchHash: createHash("sha256").update(JSON.stringify(batch)).digest("hex"),
    spaceId: "tinycloud:pkh:eip155:1:0x" + "22".repeat(20) + ":applications", host: options.host, ciphertextHash: "a".repeat(64), ...change };
  return { body, signature: await account.signMessage({ message: "tinychat.bot-history.storage/v1\n" + JSON.stringify(body) }) };
}
test("only a pinned signed receipt covering the pending challenge permits retention, including after restart", async () => {
  const { layout, journal } = setup();
  journal.begin(owner, 1000); journal.append({ type: "user", text: "hello" });
  expect(await journal.verifyCoverage()).toBe(false);
  for (const change of [{ owner: "other" }, { seq: 2 }, { challenge: "b".repeat(64) }, { batchHash: "b".repeat(64) }, { host: "https://other" }]) {
    await expect(journal.accept(await receipt(journal, change))).rejects.toThrow();
  }
  const valid = await receipt(journal);
  await expect(journal.accept({ ...valid, signature: "0x00" })).rejects.toThrow();
  const otherSigner = privateKeyToAccount("0x" + "33".repeat(32) as `0x${string}`);
  await expect(journal.accept({ ...valid, signature: await otherSigner.signMessage({ message: "tinychat.bot-history.storage/v1\n" + JSON.stringify(valid.body) }) })).rejects.toThrow("history_wrong_signer");
  await journal.accept(valid);
  expect(await journal.verifyCoverage()).toBe(true);
  const restored = new HistoryJournal(layout, options);
  expect(await restored.verifyCoverage()).toBe(true);
  await expect(restored.accept(valid)).rejects.toThrow();
  const file = join(layout.dataDir, "history.json");
  const corrupt = JSON.parse(readFileSync(file, "utf8"));
  corrupt.receipts[0].body.challenge = "c".repeat(64);
  writeFileSync(file, JSON.stringify(corrupt));
  await expect(new HistoryJournal(layout, options).verifyCoverage()).rejects.toThrow();
});
test("streamed text is persisted before terminal flush and crash recovery preserves an interrupted reply", () => {
  const { layout, journal } = setup();
  journal.begin(owner, 1000); journal.append({ type: "user", text: "hello" }); journal.startDraft(); journal.delta("partial");
  expect(journal.covered).toBe(false);
  const restored = new HistoryJournal(layout, options);
  const disk = JSON.parse(readFileSync(join(layout.dataDir, "history.json"), "utf8"));
  expect(disk.batches[1].record).toEqual({ type: "assistant", text: "partial", outcome: { type: "interrupted" }, at: expect.any(String) });
  expect(restored.pending()?.seq).toBe(1);
});
test("wrong owner and admission past the journal budget are refused", () => {
  const { journal } = setup();
  expect(() => journal.begin("other", 1)).toThrow();
  expect(() => journal.begin(owner, 9 * 1024 * 1024)).toThrow("history_full");
});

test("permission expiry never permits deletion before rendered notice; exact day 30 and delayed notice rules persist", () => {
  const { journal, layout } = setup();
  const expiry = 1_000_000;
  const day = 86_400_000;
  journal.begin(owner, 1000); journal.append({ type: "user", text: "uncopied" });
  journal.permissionExpired(expiry, owner, expiry);
  expect(journal.expiryDue(expiry + 90 * day)).toBe(false);
  const notice = journal.notice()!;
  expect(() => journal.acknowledgeNotice(notice.id, expiry, expiry + 29 * day, expiry)).toThrow("notice_date_mismatch");
  journal.acknowledgeNotice(notice.id, expiry, expiry + 30 * day, expiry);
  expect(journal.expiryDue(expiry + 30 * day - 1)).toBe(false);
  expect(journal.expiryDue(expiry + 30 * day)).toBe(true);
  expect(new HistoryJournal(layout, options).expiryDue(expiry + 30 * day)).toBe(true);
  const later = setup().journal;
  later.permissionExpired(expiry, owner, expiry);
  const delayed = expiry + 40 * day;
  later.acknowledgeNotice(later.notice()!.id, delayed, delayed + 30 * day, delayed);
  expect(later.expiryDue(delayed + 30 * day - 1)).toBe(false);
  expect(later.expiryDue(delayed + 30 * day)).toBe(true);
});

test("reconnect cancels expiry deletion and an old expiry report cannot undo renewed authority", () => {
  const { journal } = setup();
  const expiry = 1_000_000;
  const day = 86_400_000;
  journal.permissionExpired(expiry, owner, expiry);
  journal.append({ type: "user", text: "retry me" });
  journal.acknowledgeNotice(journal.notice()!.id, expiry, expiry + 30 * day, expiry);
  journal.permissionActive(expiry + 60 * day, expiry + day);
  expect(journal.notice()).toBeUndefined();
  expect(journal.expiryDue(expiry + 90 * day)).toBe(false);
  expect(journal.pending()?.record).toEqual({ type: "user", text: "retry me" });
  journal.permissionExpired(expiry, owner, expiry + 2 * day);
  expect(journal.notice()).toBeUndefined();
});

test("corrupt notice acknowledgment cannot authorize deleting uncopied history", () => {
  const { journal, layout } = setup();
  journal.permissionExpired(1000, owner, 1000);
  const path = join(layout.dataDir, "history.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.notice.deliveredAt = "forged"; value.notice.deleteAt = 0;
  writeFileSync(path, JSON.stringify(value));
  expect(() => new HistoryJournal(layout, options)).toThrow("invalid_history_notice");
});
