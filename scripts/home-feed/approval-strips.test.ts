import { afterEach, expect, test } from "bun:test";
import { listFeedCardHistory } from "@tinycloud/sdk-services/feed";
import { boardKey, parseSitrepCardPayload } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { homeMirrorRecord, publishHomeMirror, readHomeMirrorSource } from "./bridge";
import type { HomeMirrorPublishInput } from "./bridge-types";
import { boardCard, postMany } from "./inventory";
import { boardRecord, mirrorNode, NOW, SOURCE, take } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function node(): Promise<MirrorNode> { const f = await mirrorNode(); cleanup.push(() => f.close()); return f; }

const NOW_MS = Date.parse(NOW);
const CODE_URL = "https://openkey.so/delegate?user_code=ABCD-1234&state=keep-out-of-history";
const BARE_URL = "https://openkey.so/delegate";
const ONE_TAP = `https://openkey.so/a/${"a".repeat(26)}#v=4&k=${"A".repeat(43)}&c=bafkrei${"a".repeat(52)}`;
const base = { approvalType: "openkey", approvalKind: undefined, codeExpected: true, issuedAt: "2026-11-13T09:30:00.000Z" };
// Through JSON, as a board copy is read back (an undefined field is a missing one).
const open = (id: string, patch: Record<string, unknown> = {}): BoardRecord => JSON.parse(JSON.stringify(boardRecord("approval", id, { ...base, url: CODE_URL, expiresAt: "2026-11-13T11:00:00.000Z", ...patch })));
const rowOf = (record: BoardRecord) => ({ key: boardKey(record.kind, record.id), record });
const carried = (record: BoardRecord) => {
  const typed = parseSitrepCardPayload(boardCard(rowOf(record), [record], NOW_MS).payload?.sitrep);
  if (typed?.record.kind !== "approval") throw new Error("not an approval card");
  return typed.record;
};

test("an open approval carries its consent code to Home", () => {
  expect(carried(open("g1")).url).toBe(CODE_URL);
});

test("a lapsed link, an expired card and a cancelled card reach Home without the consent code, and the board's own record keeps it", () => {
  const lapsed = open("g2", { expiresAt: "2026-11-13T09:45:00.000Z" });
  const cancelled = open("g3", { status: "cancelled" });
  const expired = open("g4", { status: "expired" });
  for (const record of [lapsed, cancelled, expired]) {
    expect(carried(record).url).toBe(BARE_URL);
    expect(record.kind === "approval" && record.url).toBe(CODE_URL);
  }
});

test("a one-tap approval link is never mirrored, open or closed", async () => {
  const f = await node();
  const oneTap = open("g5", { url: ONE_TAP, issuedAt: "2026-11-13T09:50:00.000Z", expiresAt: "2026-11-13T10:30:00.000Z" });
  const closed = open("g6", { url: ONE_TAP, issuedAt: "2026-11-13T09:50:00.000Z", expiresAt: "2026-11-13T10:30:00.000Z", status: "cancelled" });
  for (const record of [oneTap, closed]) expect(() => boardCard(rowOf(record), [record], NOW_MS)).toThrow("one-tap approval links");
  const results = await postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: [oneTap, closed].map(rowOf), now: NOW_MS });
  expect(results.map((item) => [item.outcome, item.code])).toEqual([["refused", "INVALID_INPUT"], ["refused", "INVALID_INPUT"]]);
  expect(take(await listFeedCardHistory(f.output)).cards).toHaveLength(0);
});

test("the mirror gate refuses a card that still carries the code of a closed approval, and a one-tap link anywhere", async () => {
  const f = await node();
  const cancelled = open("g7", { status: "cancelled" });
  take(await f.legacy.put(boardKey("approval", "g7"), JSON.stringify(cancelled), { prefix: "", contentType: "application/json" }));
  const source = await readHomeMirrorSource(f.ctx, SOURCE);
  const row = rowOf(cancelled), card = boardCard(row, [cancelled], NOW_MS);
  const input = (payload: unknown): HomeMirrorPublishInput => ({
    source: { ...source, label: "Rocinante" }, card: { ...card, payload: { ...card.payload, sitrep: payload } } as HomeMirrorPublishInput["card"],
    legacy: { spaceId: f.ctx.legacySpaceId, fullKey: row.key, record: cancelled },
  });
  await expect(publishHomeMirror(f.ctx, input({ version: 1, record: cancelled }))).rejects.toThrow();
  expect(take(await listFeedCardHistory(f.output)).cards).toHaveLength(0);
  await publishHomeMirror(f.ctx, input(card.payload?.sitrep));
  const [stored] = take(await listFeedCardHistory(f.output)).cards;
  const typed = parseSitrepCardPayload(stored!.payload?.sitrep);
  expect(typed?.record.kind === "approval" && typed.record.url).toBe(BARE_URL);
  // The board's copy is the record as written, code included.
  expect(JSON.parse(f.values.get(boardKey("approval", "g7"))!.text).url).toBe(CODE_URL);
});

test("a closed claude sign-in has no bare form that stays valid, so it is refused", () => {
  const challenge = "B".repeat(43);
  const claude = new URL("https://claude.com/cai/oauth/authorize");
  for (const [key, value] of Object.entries({ code: "true", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", response_type: "code", redirect_uri: "https://platform.claude.com/oauth/code/callback", scope: "user:inference", code_challenge: challenge, code_challenge_method: "S256", state: challenge })) claude.searchParams.set(key, value);
  const record = open("g8", { approvalType: "claude", url: claude.href, target: "A synthetic seat" });
  expect(homeMirrorRecord(record, NOW_MS)).toEqual(record);
  const cancelled = open("g9", { approvalType: "claude", url: claude.href, target: "A synthetic seat", status: "cancelled" });
  expect(() => homeMirrorRecord(cancelled, NOW_MS)).toThrow("one-tap approval links");
});
