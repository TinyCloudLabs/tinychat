import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryJournal, type HistoryGrantUpdate, updateHistoryPermission } from "../history";
import { botLayout } from "../layout";
import { botIdFor } from "../owner";

const tmp = mkdtempSync(join(tmpdir(), "bot-history-revoke-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const owner = "did:pkh:eip155:1:0x" + "22".repeat(20);
const options = { signerDid: "did:pkh:eip155:1:0x" + "11".repeat(20), host: "https://node.test", policy: "notice-then-expiry-30-days" as const };
const DAY = 86_400_000;
const revoke = (cid: string, revision: number): HistoryGrantUpdate => ({ kind: "revoke", cid, revision });
const extend = (cid: string, revision: number): HistoryGrantUpdate => ({ kind: "extend", cid, revision });

function setup() {
  const root = mkdtempSync(join(tmp, "case-"));
  const layout = botLayout(botIdFor(owner), { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") });
  return { layout, journal: new HistoryJournal(layout, options) };
}

test("a journal revoked before it was ever tagged accepts the signed revoke and keeps it across a restart", () => {
  const { layout, journal } = setup();
  const now = Date.now();
  journal.begin(owner, 0);
  journal.permissionActive(now + DAY, now);
  expect(journal.permission).toEqual({ validUntil: now + DAY, grant: undefined });

  journal.permissionExpired(now, owner, now, revoke("grant-a", 1));
  expect(journal.permission).toMatchObject({ revoked: true, grant: { cid: "grant-a", revision: 1 } });
  expect(new HistoryJournal(layout, options).permission?.revoked).toBe(true);
});

test("a revoke for a newer generation ends the grant an older generation holds, and a repeat changes nothing", () => {
  const now = Date.now();
  const held = updateHistoryPermission(undefined, now + DAY, extend("grant-a", 1), now);
  expect(held).toEqual({ validUntil: now + DAY, grant: extend("grant-a", 1) });

  const revoked = updateHistoryPermission(held, now, revoke("grant-b", 2), now);
  expect(revoked).toEqual({ validUntil: now, grant: revoke("grant-b", 2), revoked: true });
  expect(updateHistoryPermission(revoked, now, revoke("grant-b", 2), now)).toBe(revoked);
});

test("a revoke for the same or an older generation still leaves a different grant in place", () => {
  const now = Date.now();
  const held = updateHistoryPermission(undefined, now + DAY, extend("grant-b", 2), now);
  expect(updateHistoryPermission(held, now, revoke("grant-a", 2), now)).toBe(held);
  expect(updateHistoryPermission(held, now, revoke("grant-a", 1), now)).toBe(held);
});

test("a planted link at the temporary file name is refused and its target stays untouched", () => {
  const { layout, journal } = setup();
  const outside = join(tmp, "outside.txt");
  writeFileSync(outside, "keep");
  mkdirSync(layout.dataDir, { recursive: true });
  symlinkSync(outside, join(layout.dataDir, "history.json.new"));

  expect(() => journal.begin(owner, 0)).toThrow();
  expect(readFileSync(outside, "utf8")).toBe("keep");
  expect(existsSync(join(layout.dataDir, "history.json"))).toBe(false);
});
