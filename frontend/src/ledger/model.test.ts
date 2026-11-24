import { expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { foldLedger, type LedgerRecord } from "./model";

const now = Date.parse("2026-11-23T14:00:00Z");
const did = "did:key:z6MkgkxZDxuPYD1yePpj5uErkD7NCDr48BRr6tDMShmwCaeJ";
const checker = "did:key:z6MktestChecker";
const hash = (s: string) => bytesToHex(sha256(new TextEncoder().encode(s))).slice(0, 16);
const agent = hash(did), other = hash(checker);
const prefix = "xyz.tinycloud.tinyapps.tasks/task/";
const id = (hour: string) => `20261123T${hour}00000000000Z-aabbccdd`;
function event(hour = "12", body: Record<string, unknown> = {}, task = "write", folder = agent): LedgerRecord {
  return { key: `${prefix}${folder}/${task}/${id(hour)}.json`, value: { taskId: task, title: "Prepare the release", stage: "Building", stageSince: "2026-11-23T10:00:00Z", agent: did, ...body } };
}
function check(hour = "13", body: Record<string, unknown> = {}, folder = other): LedgerRecord {
  return { key: `${prefix}${folder}/checks/${agent}/write/${id(hour)}.json`, value: { checkedBy: checker, evidence: "Release reviewed", at: `2026-11-23T${hour}:00:00Z`, ...body } };
}

test("orders append IDs, not stages or input order; condition snapshots keep stage age", () => {
  const rows = foldLedger([event("13", { stage: "Planned", condition: "Waiting on you" }), event("11", { stage: "Released" }), event("12", { stage: "Planned" })], now);
  expect(rows[0]).toMatchObject({ stage: "Planned", stageSince: "2026-11-23T10:00:00Z", condition: "Waiting on you" });
});
test("a doer-only Checked does not count as independent acceptance", () => {
  expect(foldLedger([event("12", { stage: "Checked" })], now)[0]?.stage).toBe("Done by agent, not checked");
});
test("another folder's hash-matched check accepts work, including a checker with no tasks", () => {
  expect(foldLedger([check(), event()], now)[0]).toMatchObject({ stage: "Checked", checkedBy: `Agent ${other}`, evidence: "Release reviewed", stageSince: "2026-11-23T13:00:00Z" });
});
test("identifies the checker by its cached owner name and hash-verified folder", () => {
  const row = foldLedger([check(), event()], now, new Map([[checker, "Review agent"]]))[0];
  expect(row).toMatchObject({ checkedBy: `Review agent · ${other}`, evidence: "Release reviewed" });
});
test("self checks and forged checker folders never accept work", () => {
  for (const record of [check("13", { checkedBy: did }, agent), check("13", {}, "0000000000000000")]) {
    expect(foldLedger([event(), record], now)[0]?.stage).toBe("Building");
  }
});
test("new work after a check needs a new check", () => {
  expect(foldLedger([event("11"), check("12"), event("13")], now)[0]?.stage).toBe("Building");
});
test("rejects mismatched hashes, task paths, invalid times and stages", () => {
  for (const record of [event("12", {}, "write", "0000000000000000"), event("12", { taskId: "other" }), event("12", { stageSince: "yesterday" }), event("12", { stage: "Done" })]) {
    expect(foldLedger([record], now)).toEqual([]);
  }
  expect(foldLedger([event("12", { agent: `${did}#key-1` })], now)).toHaveLength(1);
});
test("caps text, drops unknown fields, renders literal markup and masks credentials before truncating", () => {
  const row = foldLedger([event("12", { title: "<script>literal</script> " + "x".repeat(210), note: "Bearer abcdefghijklmnopqrstuvwxyz https://example.test/proof?token=secret#private sk-test012345678901234567890123456789", agentName: "Writer".repeat(20), link: "https://ignored.test" })], now)[0]!;
  expect(row.title).toStartWith("<script>literal</script>");
  expect(row.title.length).toBeLessThanOrEqual(200);
  expect(row.agentLabel.length).toBeLessThanOrEqual(79);
  expect(row.note).not.toContain("abcdefghijklmnopqrstuvwxyz");
  expect(row.note).not.toContain("secret");
  expect(row.note).not.toContain("private");
  expect(row.note).not.toContain("sk-test");
  expect(row).not.toHaveProperty("link");
});
test("counts unique dependencies only when they resolve to visible rows", () => {
  const rows = foldLedger([event("12", { blockedBy: [`${agent}/other`, `${agent}/other`, `${other}/missing`], blocks: [`${agent}/other`] }), event("12", {}, "other")], now);
  expect(rows.find((row) => row.id === `${agent}/write`)).toMatchObject({ blockedBy: 1, blocks: 1 });
});
test("hides completed tasks after 30 days but keeps active tasks", () => {
  const old = Date.parse("2026-12-25T14:00:00Z");
  expect(foldLedger([event("12", { stage: "Checked" })], old)).toEqual([]);
  expect(foldLedger([event(), check()], old)).toEqual([]);
  expect(foldLedger([event()], old)).toHaveLength(1);
});
test("check evidence is plain capped text, with bearer links stripped", () => {
  const row = foldLedger([event(), check("13", { evidence: "Proof https://example.test/?access_token=secret#private " + "x".repeat(250) })], now)[0]!;
  expect(row.evidence?.length).toBeLessThanOrEqual(200);
  expect(row.evidence).not.toContain("secret");
  expect(row.evidence).not.toContain("private");
});
