import { expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { foldLedger, ledgerText, type LedgerRecord } from "./model";
const j = (...parts: string[]) => parts.join("");

const now = Date.parse("2026-11-23T14:00:00Z");
const did = "did:key:z6MkgkxZDxuPYD1yePpj5uErkD7NCDr48BRr6tDMShmwCaeJ";
const checker = "did:key:z6MktestChecker";
const hash = (s: string) => bytesToHex(sha256(new TextEncoder().encode(s))).slice(0, 16);
const agent = hash(did), other = hash(checker);
const prefix = "xyz.tinycloud.tinyapps.tasks/task/";
const at = (hhmmss: string) => `20261123T${hhmmss}000Z-aabbccdd`;
function event(file = at("120000"), body: Record<string, unknown> = {}): LedgerRecord {
  return { key: `${prefix}${agent}/write/${file}.json`.replace("Z-aabbccdd.json.json", "Z-aabbccdd.json"), value: { taskId: "write", title: "Prepare the release", stage: "Building", stageSince: "2026-11-23T12:00:00Z", agent: did, ...body } };
}
test("Released and Turned on tasks hide after 30 days like other done tasks", () => {
  const old = Date.parse("2026-12-25T14:00:00Z");
  expect(foldLedger([event(at("120000"), { stage: "Released" })], old)).toEqual([]);
  expect(foldLedger([event(at("120000"), { stage: "Turned on" })], old)).toEqual([]);
  expect(foldLedger([event(at("120000"), { stage: "Released" })], now)).toHaveLength(1);
});
test("a backdated stageSince does not hide a recent entry, and a written agentName is not shown as the agent's name", () => {
  const row = foldLedger([event(at("120000"), { stage: "Released", stageSince: "2026-01-01T00:00:00Z", agentName: "Holden" })], now);
  expect(row).toHaveLength(1);
  expect(row[0]!.agentLabel).toBe(`Agent ${agent}`);
});
test("masks passwords with slashes or at signs, spaced and arrow keys, escaped JSON, ASIA keys and key material", () => {
  const asia = j("ASIA", "ABCDEFGHIJKLMNOP"), jwk = j('{"', 'd":"abcdefghijklmnopqrstuvwxyz0123456789ABCD"}');
  const out = ledgerText(j("see post", "gres://u:pa/ss@wo#rd@db/app and ", '"api key: hunter2" and {"pass', 'word"=>"hunter3"} and {\\"pass', 'word\\":\\"hunter4\\"} and '), 600) + ledgerText(`${asia} and ${jwk}`, 600);
  for (const leak of ["pa/ss", "rd@db", "hunter2", "hunter3", "hunter4", asia, "abcdefghijklmnopqrstuvwxyz"]) expect(out).not.toContain(leak);
});
const fileKey = (file: string, body: Record<string, unknown> = {}): LedgerRecord => ({ ...event(undefined, body), key: `${prefix}${agent}/write/${file}.json` });
const checkKey = (file: string, body: Record<string, unknown> = {}): LedgerRecord => ({
  key: `${prefix}${other}/checks/${agent}/write/${file}.json`,
  value: { checkedBy: checker, evidence: "Release reviewed", at: "2026-11-23T13:00:00Z", ...body },
});

test("credential-looking text is masked in the forms agents write by accident", () => {
  const stripe = j("sk_", "live_", "abcdefghijkl"), gitlab = j("glpat", "-abcdefghijklmnopqrst");
  const samples = [
    j("DATABASE_URL=post", "gres://app:S3cret", "Pass@db.internal:5432/app"),
    j("see wss://x/socket?tok", "en=S3CRETVALUE"),
    j('{"pass', 'word": "hunter2"}'),
    j("client_sec", "ret=abc123def"),
    j("db_pass", "word=abc123def"),
    j("aws_secret_access", "_key = abc123def"),
    j("tok", "en=abc123def"),
    j("Authorization: Bas", "ic dXNlcjpwYXNz"),
    j("Authorization: Tok", "en abc123def"),
    stripe,
    gitlab,
    j("https://TOKEN", "VALUE@host.example/x"),
  ];
  for (const sample of samples) {
    const shown = ledgerText(sample, 500);
    for (const secret of ["S3cretPass", "S3CRETVALUE", "hunter2", "abc123def", "dXNlcjpwYXNz", stripe, gitlab, "TOKENVALUE"]) {
      expect(shown).not.toContain(secret);
    }
  }
});
test("control and zero-width characters cannot split a credential past the mask", () => {
  expect(ledgerText(j("Bearer\u0001", "SECRETTOKEN", "123"), 200)).not.toContain("SECRETTOKEN123");
  expect(ledgerText(j("gh", "p_abcdefgh\u200bijklmnopqrstuvwx"), 200)).not.toContain(j("gh", "p_abcdefgh"));
  expect(ledgerText("a secret straddling the cap " + "x".repeat(150) + j(" pass", "word=hunter2hunter2"), 200)).not.toContain("hunter2");
});
test("ordinary evidence is not masked", () => {
  const commit = "4f85d773e0".repeat(4);
  expect(ledgerText(`PR 123 merged and live at ${commit}`, 200)).toBe(`PR 123 merged and live at ${commit}`);
});
test("a +00:00 time written by an agent is accepted", () => {
  const rows = foldLedger([fileKey(at("120000"), { stageSince: "2026-11-23T12:00:00+00:00" })], now);
  expect(rows).toHaveLength(1);
});
test("a check whose time is far from its own event time is ignored", () => {
  const rows = foldLedger([fileKey(at("120000")), checkKey(at("130000"), { at: "2000-01-01T00:00:00Z" })], now);
  expect(rows[0]!.stage).toBe("Building");
  expect(rows[0]!.checkedBy).toBeUndefined();
});
test("an event id far in the future is ignored, so it cannot pin or block a task", () => {
  const rows = foldLedger([fileKey(at("120000")), fileKey("99991231T235959000Z-aabbccdd", { stage: "Dropped" })], now);
  expect(rows[0]!.stage).toBe("Building");
  const checked = foldLedger([fileKey(at("120000")), checkKey("99991231T235959000Z-aabbccdd", { at: "9999-12-31T23:59:59Z" })], now);
  expect(checked[0]).toMatchObject({ stage: "Building" });
});
test("a few minutes of clock skew does not hide a fresh task", () => {
  const rows = foldLedger([fileKey(at("135800"), { stageSince: "2026-11-23T14:02:00Z" })], now);
  expect(rows).toHaveLength(1);
});
test("near-miss conditions still show: a trailing period, case, and a line break in the reason", () => {
  expect(foldLedger([fileKey(at("120000"), { condition: "Waiting on you." })], now)[0]!.condition).toBe("Waiting on you.");
  expect(foldLedger([fileKey(at("120000"), { condition: "waiting on you" })], now)[0]!.condition).toBe("waiting on you");
  expect(foldLedger([fileKey(at("120000"), { condition: "Blocked: CI\nand review" })], now)[0]!.condition).toBe("Blocked: CI and review");
  expect(foldLedger([fileKey(at("120000"), { condition: "anything else" })], now)[0]!.condition).toBeUndefined();
});
