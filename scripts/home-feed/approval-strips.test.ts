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
import { boardCard, parseInventoryKinds, readBoardIndex } from "./inventory";
import { boardRecord, mirrorNode, NOW, SOURCE, take } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function node(): Promise<MirrorNode> { const f = await mirrorNode(); cleanup.push(() => f.close()); return f; }

const NOW_MS = Date.parse(NOW);
const CODE_URL = "https://openkey.so/delegate?user_code=ABCD-1234&state=keep-out-of-history";
const BARE_URL = "https://openkey.so/delegate";
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

test("the mirror gate strips a closed approval's Home card itself and refuses a card that is not the board record or its stripped form", async () => {
  const f = await node();
  const cancelled = open("g7", { status: "cancelled" });
  take(await f.legacy.put(boardKey("approval", "g7"), JSON.stringify(cancelled), { prefix: "", contentType: "application/json" }));
  const source = await readHomeMirrorSource(f.ctx, SOURCE);
  const row = rowOf(cancelled), card = boardCard(row, [cancelled], NOW_MS);
  const input = (record: unknown, board: BoardRecord = cancelled): HomeMirrorPublishInput => ({
    source: { ...source, label: "Rocinante" }, card: { ...card, payload: { ...card.payload, sitrep: { version: 1, record } } } as HomeMirrorPublishInput["card"],
    legacy: { spaceId: f.ctx.legacySpaceId, fullKey: boardKey(board.kind, board.id), record: board },
  });
  const other = open("g7", { status: "cancelled", url: "https://openkey.so/delegate?user_code=WXYZ-9999" });
  await expect(publishHomeMirror(f.ctx, input(other))).rejects.toThrow();
  expect(take(await listFeedCardHistory(f.output)).cards).toHaveLength(0);
  // A payload that still holds the closed approval's code is stripped by the gate, not refused.
  await publishHomeMirror(f.ctx, input(cancelled));
  const [stored] = take(await listFeedCardHistory(f.output)).cards;
  const typed = parseSitrepCardPayload(stored!.payload?.sitrep);
  expect(typed?.record.kind === "approval" && typed.record.url).toBe(BARE_URL);
  // The board's copy is the record as written, code included.
  expect(JSON.parse(f.values.get(boardKey("approval", "g7"))!.text).url).toBe(CODE_URL);
});

test("a card built just before its link lapses and published just after reaches Home without the code, not refused", async () => {
  const f = await node();
  const record = open("g12", { expiresAt: new Date(NOW_MS + 30_000).toISOString() });
  take(await f.legacy.put(boardKey("approval", "g12"), JSON.stringify(record), { prefix: "", contentType: "application/json" }));
  const source = await readHomeMirrorSource(f.ctx, SOURCE);
  const row = rowOf(record), card = boardCard(row, [record], NOW_MS);
  expect(parseSitrepCardPayload(card.payload?.sitrep)?.record).toEqual(record);
  const later = { ...f.ctx, now: () => new Date(NOW_MS + 60_000).toISOString() };
  await publishHomeMirror(later, { source: { ...source, label: "Rocinante" }, card, legacy: { spaceId: f.ctx.legacySpaceId, fullKey: row.key, record } });
  const [stored] = take(await listFeedCardHistory(f.output)).cards;
  const typed = parseSitrepCardPayload(stored!.payload?.sitrep);
  expect(typed?.record.kind === "approval" && typed.record.url).toBe(BARE_URL);
  expect(JSON.parse(f.values.get(boardKey("approval", "g12"))!.text).url).toBe(CODE_URL);
});

test("a closed claude sign-in has no bare form that stays valid, so it is refused", () => {
  const challenge = "B".repeat(43);
  const claude = new URL("https://claude.com/cai/oauth/authorize");
  for (const [key, value] of Object.entries({ code: "true", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", response_type: "code", redirect_uri: "https://platform.claude.com/oauth/code/callback", scope: "user:inference", code_challenge: challenge, code_challenge_method: "S256", state: challenge })) claude.searchParams.set(key, value);
  const record = open("g8", { approvalType: "claude", url: claude.href, target: "A synthetic seat" });
  expect(homeMirrorRecord(record, NOW_MS)).toEqual(record);
  const cancelled = open("g9", { approvalType: "claude", url: claude.href, target: "A synthetic seat", status: "cancelled" });
  expect(() => homeMirrorRecord(cancelled, NOW_MS)).toThrow("consent code of a closed approval");
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

test("a Claude sign-in is carried only while open", () => {
  const challenge = "B".repeat(43);
  const claude = new URL("https://claude.com/cai/oauth/authorize");
  for (const [key, value] of Object.entries({ code: "true", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", response_type: "code", redirect_uri: "https://platform.claude.com/oauth/code/callback", scope: "user:inference", code_challenge: challenge, code_challenge_method: "S256", state: challenge })) claude.searchParams.set(key, value);
  const seat = (id: string, patch: Record<string, unknown> = {}) => open(id, { approvalType: "claude", url: claude.href, target: "A synthetic seat", ...patch });
  expect(carried(seat("c1")).url).toBe(claude.href);
  for (const [label, patch] of closedStates) {
    const status = label === "lapsed link" ? "open" : label;
    expect(() => homeMirrorRecord(seat(`c-${status}`, { status, ...patch }), NOW_MS)).toThrow("consent code of a closed approval");
  }
});
