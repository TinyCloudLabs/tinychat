/**
 * An approval card may say when its grant was used (`redeemedAt`) and how long the access lasts (`grantLifetime`).
 * The record schemas are strict, so a card carrying either was refused whole by every path that reads a board record;
 * both fields are optional, and only on an approval.
 */
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { grantLifetimeHours, parseSitrepCardPayload, prepareSitrepImport, validatePreparedOwnerArchive, validateRecord } from "@tinyboilerplate/core/feed/sitrep";
import type { PrepareSitrepImportInput } from "@tinyboilerplate/core/feed/sitrep";
import { SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";

/** An OpenKey read grant of the shape the officers post today. */
const grant = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...syntheticRecord("approval"), approvalType: "openkey", approvalKind: undefined, codeExpected: true, names: ["SYNTHETIC_KEY"], scope: "synthetic-scope",
  url: "https://openkey.so/delegate?fixture=synthetic", ...extra,
});
const REDEEMED = "2026-10-29T12:05:00.000Z";

test("an approval may carry when it was used and how long its access lasts, and keeps both", () => {
  const checked = validateRecord("approval", grant({ redeemedAt: REDEEMED, grantLifetime: "12h" }));
  expect(checked.ok).toBe(true);
  if (checked.ok) {
    expect(checked.value.redeemedAt).toBe(REDEEMED);
    expect(checked.value.grantLifetime).toBe("12h");
  }
  const none = validateRecord("approval", grant());
  expect(none.ok && none.value.redeemedAt).toBe(undefined);
  expect(none.ok && none.value.grantLifetime).toBe(undefined);
  // A go approval is the other shape the card takes; the fields are optional there too.
  expect(validateRecord("approval", { ...syntheticRecord("approval"), redeemedAt: REDEEMED, grantLifetime: "1h" }).ok).toBe(true);
});

test("a lifetime is a whole number of hours or days and at most 30 days", () => {
  for (const good of ["1h", "12h", "24h", "720h", "1d", "7d", "30d"]) expect(validateRecord("approval", grant({ grantLifetime: good })).ok, good).toBe(true);
  for (const bad of ["", "0h", "0d", "01h", "1", "h", "d", "1w", "1m", "1.5h", "-1h", "+1h", " 1h", "1h ", "1H", "1 h", "721h", "31d", "999999d", "1h1h", 12]) {
    expect(validateRecord("approval", grant({ grantLifetime: bad })).ok, String(bad)).toBe(false);
  }
  expect(grantLifetimeHours("7d")).toBe(168);
  expect(grantLifetimeHours("12h")).toBe(12);
  expect(Number.isNaN(grantLifetimeHours("7 days"))).toBe(true);
});

test("a used time that is not a datetime is refused", () => {
  for (const bad of ["", "yesterday", "2026-10-29", "2026-10-29T12:05:00", 1793275500000]) expect(validateRecord("approval", grant({ redeemedAt: bad })).ok, String(bad)).toBe(false);
});

test("the two fields go on an approval only, and unknown fields are still refused", () => {
  for (const kind of ["ask", "task", "incident", "work", "progress"]) {
    expect(validateRecord(kind as "ask", { ...syntheticRecord(kind), redeemedAt: REDEEMED }).ok, `${kind} redeemedAt`).toBe(false);
    expect(validateRecord(kind as "ask", { ...syntheticRecord(kind), grantLifetime: "1h" }).ok, `${kind} grantLifetime`).toBe(false);
  }
  expect(validateRecord("approval", grant({ redeemedAtMs: 1 })).ok).toBe(false);
});

test("the Home card payload keeps both fields, and a bad one makes the payload unsupported", () => {
  const typed = parseSitrepCardPayload({ version: 1, record: grant({ redeemedAt: REDEEMED, grantLifetime: "7d" }) });
  expect(typed?.record.kind === "approval" && [typed.record.redeemedAt, typed.record.grantLifetime]).toEqual([REDEEMED, "7d"]);
  expect(parseSitrepCardPayload({ version: 1, record: grant({ grantLifetime: "31d" }) })).toBe(null);
  expect(parseSitrepCardPayload({ version: 1, record: grant({ redeemedAt: "yesterday" }) })).toBe(null);
});

const cardKey = "xyz.tinycloud.rocinante/board/approval/approval-synthetic.json";
function importOf(record: unknown, bind: boolean): PrepareSitrepImportInput {
  const bytes = Buffer.from(JSON.stringify(record));
  const source = { agentId: "archive", agentDid: "did:key:isolated-archive", output: "xyz.tinycloud.tinychat/feed/feed_output_archive", responses: "xyz.tinycloud.tinychat/feed/feed_responses_archive" };
  return {
    source: { spaceId: "isolated-legacy-space", namespace: "xyz.tinycloud.rocinante/", snapshotId: "approval-snapshot", completePrefixSnapshot: false }, frozenAt: SITREP_NOW,
    rows: [{ sourceKey: cardKey, sourceArea: "kv", encoding: "base64", rawBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") }],
    publishers: [{ publisherId: "legacy", agentId: source.agentId, agentDid: source.agentDid, outputResource: source.output, responseResource: source.responses }],
    publisherBindings: bind ? [{ sourceKey: cardKey, publisherId: "legacy", identity: { cardId: "approval-card", revision: 1, issuanceId: "approval-card-issuance" } }] : [],
    recipients: [],
  };
}

test("the import keeps an approval carrying both fields instead of quarantining it, and still quarantines a bad one", async () => {
  const good = await prepareSitrepImport(importOf(grant({ redeemedAt: REDEEMED, grantLifetime: "12h" }), true));
  expect(good.quarantine).toEqual([]);
  expect(good.cards.map((card) => card.record.kind === "approval" && card.record.grantLifetime)).toEqual(["12h"]);
  const bad = await prepareSitrepImport(importOf(grant({ grantLifetime: "31d" }), false));
  expect(bad.cards).toEqual([]);
  expect(bad.quarantine.map((item) => [item.sourceKey, item.reason])).toEqual([[cardKey, "invalid"]]);
});

test("the archive accepts an approval carrying both fields and refuses one whose lifetime was tampered", async () => {
  const bundle = await prepareSitrepImport(importOf(grant({ redeemedAt: REDEEMED, grantLifetime: "12h" }), true));
  const archived = await validatePreparedOwnerArchive(JSON.parse(JSON.stringify(bundle)));
  expect(archived.cards[0]?.record.kind === "approval" && archived.cards[0].record.redeemedAt).toBe(REDEEMED);
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.cards[0].record.grantLifetime = "31d";
  await expect(validatePreparedOwnerArchive(tampered)).rejects.toThrow();
});
