import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFeedCardHistory } from "@tinycloud/sdk-services/feed";
import { boardKey, parseSitrepCardPayload } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { homeMirrorRecord, publishHomeMirror, readHomeMirrorSource } from "./bridge";
import type { HomeMirrorPublishInput } from "./bridge-types";
import { boardCard, parseInventoryKinds, postMany, readBoardIndex } from "./inventory";
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

test("the board-index read returns open approvals and leaves closed ones out (local fixture)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "home-approvals-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "board-index.sqlite");
  const rows = [[open("g10"), 0], [open("g11", { status: "cancelled" }), 1], [boardRecord("ask", "a10"), 0]] as const;
  const db = new Database(path);
  db.exec("CREATE TABLE records (key TEXT PRIMARY KEY, etag TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, kind TEXT NOT NULL, closed INTEGER NOT NULL, created_ms INTEGER NOT NULL, record_json TEXT)");
  rows.forEach(([record, closed], index) => db.query("INSERT INTO records (key,id,kind,closed,created_ms,record_json) VALUES (?,?,?,?,?,?)").run(boardKey(record.kind, record.id), record.id, record.kind, closed, index, JSON.stringify(record)));
  db.close();
  const { rows: found, skipped } = readBoardIndex(path, parseInventoryKinds(undefined));
  expect(found.map((row) => row.key)).toEqual([boardKey("approval", "g10"), boardKey("ask", "a10")]);
  expect(skipped).toEqual([]);
});

const closedStates = [["cancelled", {}], ["expired", {}], ["lapsed link", { expiresAt: "2026-11-13T09:45:00.000Z" }]] as const;

test("each OpenKey consent page (delegate, device, oauth/consent) is carried whole while open and bare once closed or lapsed", () => {
  for (const path of ["delegate", "device", "oauth/consent"]) {
    const url = `https://openkey.so/${path}?user_code=ABCD-1234&state=keep-out-of-history`, slug = path.replace("/", "-");
    expect(carried(open(`k-${slug}`, { url })).url).toBe(url);
    for (const [label, patch] of closedStates) {
      const status = label === "lapsed link" ? "open" : label;
      expect(carried(open(`k-${slug}-${status}`, { url, status, ...patch })).url).toBe(`https://openkey.so/${path}`);
    }
  }
});

test("a Secrets request is carried whole while open and bare once closed or lapsed", () => {
  const url = "https://secrets.tinycloud.xyz/request?fixture=synthetic&names=SYNTHETIC_KEY";
  const secret = (id: string, patch: Record<string, unknown> = {}) => open(id, { approvalType: "secret", codeExpected: false, name: "SYNTHETIC_KEY", url, ...patch });
  expect(carried(secret("s1")).url).toBe(url);
  for (const [label, patch] of closedStates) {
    const status = label === "lapsed link" ? "open" : label;
    const record = secret(`s-${status}`, { status, ...patch });
    expect(carried(record).url).toBe("https://secrets.tinycloud.xyz/request");
    expect(record.kind === "approval" && record.url).toBe(url);
  }
});

test("a one-tap link is refused for every kind of approval state, and a Claude sign-in is carried only while open", () => {
  for (const status of ["open", "cancelled", "expired"]) {
    expect(() => homeMirrorRecord(open(`o-${status}`, { url: ONE_TAP, issuedAt: "2026-11-13T09:50:00.000Z", expiresAt: "2026-11-13T10:30:00.000Z", status }), NOW_MS)).toThrow("one-tap approval links");
  }
  const challenge = "B".repeat(43);
  const claude = new URL("https://claude.com/cai/oauth/authorize");
  for (const [key, value] of Object.entries({ code: "true", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", response_type: "code", redirect_uri: "https://platform.claude.com/oauth/code/callback", scope: "user:inference", code_challenge: challenge, code_challenge_method: "S256", state: challenge })) claude.searchParams.set(key, value);
  const seat = (id: string, patch: Record<string, unknown> = {}) => open(id, { approvalType: "claude", url: claude.href, target: "A synthetic seat", ...patch });
  expect(carried(seat("c1")).url).toBe(claude.href);
  for (const [label, patch] of closedStates) {
    const status = label === "lapsed link" ? "open" : label;
    expect(() => homeMirrorRecord(seat(`c-${status}`, { status, ...patch }), NOW_MS)).toThrow("one-tap approval links");
  }
});
