/**
 * A board card may carry `post`: the one line a Home card leads with. The record schemas are strict, so every path that
 * reads a board record (validation, the Home card payload, the import, the archive) must accept it, and refuse a bad one.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseSitrepCardPayload, POST_MAX, prepareSitrepImport, validatePreparedOwnerArchive, validateRecord } from "@tinyboilerplate/core/feed/sitrep";
import type { Kind, PrepareSitrepImportInput } from "@tinyboilerplate/core/feed/sitrep";
import { SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";

const KINDS: Kind[] = ["ask", "task", "incident", "work", "progress"];
const withPost = (kind: Kind, post: unknown) => ({ ...syntheticRecord(kind), post });

const refused: Array<[string, string]> = [
  ["an empty post", ""],
  ["a post of only spaces", "   \n  "],
  ["281 characters", "a".repeat(POST_MAX + 1)],
  ["281 code points that are each two UTF-16 units", "😀".repeat(POST_MAX + 1)],
  ["a NUL", "Shipped\u0000 it"],
  ["a tab", "Shipped\tit"],
  ["a lone carriage return", "Shipped\rit"],
  ["an escape", "Shipped \u001b[31mred"],
  ["a DEL", "Shipped\u007fit"],
  ["a C1 control", "Shipped\u0085it"],
  ["a lone high surrogate", "Shipped \uD83D it"],
  ["a lone low surrogate", "Shipped \uDE00 it"],
  ["a reversed surrogate pair", "Shipped \uDE00\uD83D it"],
  ["a line separator U+2028", "Shipped\u2028it"],
  ["a paragraph separator U+2029", "Shipped\u2029it"],
  ["a zero-width space U+200B", "Shipped\u200Bit"],
  ["a zero-width non-joiner U+200C", "Shipped\u200Cit"],
  ["a byte order mark inside the text", "Shipped\uFEFFit"],
  ["a 281st code point after a ZWJ emoji run", "👨‍👩‍👧‍👦".repeat(40) + "a"],
];

test("a card of any kind may carry a post, and keeps it trimmed", () => {
  for (const kind of KINDS) {
    const checked = validateRecord(kind, withPost(kind, "  Reconnect fixed; one check left.  "));
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value.post).toBe("Reconnect fixed; one check left.");
  }
  const none = validateRecord("task", syntheticRecord("task"));
  expect(none.ok && none.value.post).toBe(undefined);
});

test("a post is at most 280 Unicode code points, counted as code points and not UTF-16 units", () => {
  expect(POST_MAX).toBe(280);
  for (const post of ["a".repeat(280), "😀".repeat(280), "a".repeat(279) + "😀", "Line one\nLine two"]) {
    expect(validateRecord("task", withPost("task", post)).ok).toBe(true);
  }
  expect("😀".repeat(280).length).toBe(560);
});

test("a ZWJ emoji sequence is accepted and counted by code point, and a CRLF post is normalised to LF", () => {
  const family = "👨‍👩‍👧‍👦";
  expect([...family].length).toBe(7);
  const kept = validateRecord("task", withPost("task", family + " shipped"));
  expect(kept.ok && kept.value.post).toBe(family + " shipped");
  expect(validateRecord("task", withPost("task", family.repeat(40))).ok).toBe(true);
  const crlf = validateRecord("task", withPost("task", "\r\nFirst line\r\nSecond line\r\n"));
  expect(crlf.ok && crlf.value.post).toBe("First line\nSecond line");
  // A surrogate pair is not a lone surrogate; well-formed astral text passes at 280 and fails at 281.
  expect(validateRecord("task", withPost("task", "a".repeat(279) + "😀")).ok).toBe(true);
  expect(validateRecord("task", withPost("task", "a".repeat(280) + "😀")).ok).toBe(false);
});

test("a post that is empty, too long, or has a control character other than a newline is refused", () => {
  for (const [name, post] of refused) {
    const checked = validateRecord("task", withPost("task", post));
    expect(checked.ok, name).toBe(false);
  }
  expect(validateRecord("task", withPost("task", 42)).ok).toBe(false);
});

test("the Home card payload carries the post, and a bad one makes the payload unsupported", () => {
  const typed = parseSitrepCardPayload({ version: 1, record: withPost("ask", "Needs your yes on the deploy.") });
  expect(typed?.record.post).toBe("Needs your yes on the deploy.");
  for (const [name, post] of refused) expect(parseSitrepCardPayload({ version: 1, record: withPost("ask", post) }), name).toBe(null);
});

const cardKey = "xyz.tinycloud.rocinante/board/task/task-synthetic.json";
function row(sourceKey: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { sourceKey, sourceArea: "kv" as const, encoding: "base64" as const, rawBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}
function importOf(record: unknown, bind: boolean): PrepareSitrepImportInput {
  const source = { agentId: "archive", agentDid: "did:key:isolated-archive", output: "xyz.tinycloud.tinychat/feed/feed_output_archive", responses: "xyz.tinycloud.tinychat/feed/feed_responses_archive" };
  return {
    source: { spaceId: "isolated-legacy-space", namespace: "xyz.tinycloud.rocinante/", snapshotId: "post-snapshot", completePrefixSnapshot: false }, frozenAt: SITREP_NOW,
    rows: [row(cardKey, record)],
    publishers: [{ publisherId: "legacy", agentId: source.agentId, agentDid: source.agentDid, outputResource: source.output, responseResource: source.responses }],
    publisherBindings: bind ? [{ sourceKey: cardKey, publisherId: "legacy", identity: { cardId: "post-card", revision: 1, issuanceId: "post-card-issuance" } }] : [],
    recipients: [],
  };
}

test("the import keeps a valid post on the card, and quarantines a card whose post is bad", async () => {
  const good = await prepareSitrepImport(importOf(withPost("task", "Reconnect fixed; one check left."), true));
  expect(good.quarantine).toEqual([]);
  expect(good.cards.map((card) => card.record.post)).toEqual(["Reconnect fixed; one check left."]);
  for (const [name, post] of refused) {
    const bad = await prepareSitrepImport(importOf(withPost("task", post), false));
    expect(bad.cards, name).toEqual([]);
    expect(bad.quarantine.map((item) => [item.sourceKey, item.reason]), name).toEqual([[cardKey, "invalid"]]);
  }
});

test("the archive accepts a card with a valid post, and refuses one whose post is bad", async () => {
  const bundle = await prepareSitrepImport(importOf(withPost("task", "Reconnect fixed; one check left."), true));
  expect((await validatePreparedOwnerArchive(JSON.parse(JSON.stringify(bundle)))).cards[0]?.record.post).toBe("Reconnect fixed; one check left.");
  for (const [name, post] of refused) {
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.cards[0].record.post = post;
    await expect(validatePreparedOwnerArchive(tampered), name).rejects.toThrow();
  }
});
