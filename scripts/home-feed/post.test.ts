/**
 * A board card may carry `post` (the one line a Home card leads with). The Home mirror reads board records in two places,
 * the board index (inventory) and the board's own copy (the bridge, which re-reads it before it posts), and both validate
 * with the strict record schema: a card with a good post must be mirrored, a card with a bad one must be refused.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFeedCardHistory } from "@tinycloud/sdk-services/feed";
import { boardKey } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { boardCard, parseInventoryKinds, postMany, readBoardIndex } from "./inventory";
import { boardRecord, mirrorNode, NOW, SOURCE, take } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function node(): Promise<MirrorNode> { const f = await mirrorNode(); cleanup.push(() => f.close()); return f; }
async function directory(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "home-post-")); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir; }

const GOOD = "Reconnect fixed; one check left.";
const EDGE = "😀".repeat(280);
const bad = ["", "a".repeat(281), "😀".repeat(281), "Shipped\u0000 it", "Shipped \uD83D it", "Shipped\u2028it", "Shipped\u200Bit"];
const ZWJ = "👨‍👩‍👧‍👦 shipped";
const payloadPost = (card: { payload?: Record<string, unknown> | undefined }) => (card.payload?.sitrep as { record: { post?: string } }).record.post;
const putBoard = (f: MirrorNode, record: unknown, key: string) =>
  f.legacy.put(key, JSON.stringify(record), { prefix: "", contentType: "application/json" }).then((result) => take(result));

function writeIndex(path: string, rows: Array<{ kind: string; id: string; record: unknown }>) {
  const db = new Database(path);
  db.exec("CREATE TABLE records (key TEXT PRIMARY KEY, etag TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, kind TEXT NOT NULL, closed INTEGER NOT NULL, created_ms INTEGER NOT NULL, record_json TEXT)");
  rows.forEach((row, index) => db.query("INSERT INTO records (key,id,kind,closed,created_ms,record_json) VALUES (?,?,?,?,?,?)").run(boardKey(row.kind as "ask", row.id), row.id, row.kind, 0, index, JSON.stringify(row.record)));
  db.close();
}

test("the board index reads a card with a good post (280 code points included) and skips one with a bad post as unreadable", async () => {
  const path = join(await directory(), "board-index.sqlite");
  writeIndex(path, [
    { kind: "ask", id: "with-post", record: boardRecord("ask", "with-post", { post: GOOD }) },
    { kind: "task", id: "edge-post", record: boardRecord("task", "edge-post", { post: EDGE }) },
    { kind: "work", id: "zwj-post", record: boardRecord("work", "zwj-post", { post: ZWJ }) },
    { kind: "incident", id: "crlf-post", record: { ...boardRecord("incident", "crlf-post"), post: "First line\r\nSecond line" } },
    ...bad.map((post, index) => ({ kind: "ask", id: `bad-${index}`, record: { ...boardRecord("ask", `bad-${index}`), post } })),
  ]);
  const { rows, skipped } = readBoardIndex(path, parseInventoryKinds(undefined));
  expect(rows.map((row) => [row.record.id, row.record.post])).toEqual([["with-post", GOOD], ["edge-post", EDGE], ["zwj-post", ZWJ], ["crlf-post", "First line\nSecond line"]]);
  expect(skipped.map((skip) => skip.reason)).toEqual(bad.map(() => "unreadable"));
});

test("the Home card for a board card carries the post at payload.sitrep.record.post", () => {
  const record = boardRecord("ask", "with-post", { post: GOOD });
  expect(payloadPost(boardCard({ key: boardKey("ask", "with-post"), record }, [record], Date.parse(NOW)))).toBe(GOOD);
});

test("the mirror re-reads the board's own copy: a good post is posted, a bad post in that copy is refused, and the cause is the record, not a changed copy", async () => {
  const f = await node();
  const good = boardRecord("ask", "with-post", { post: GOOD }), edge = boardRecord("task", "edge-post", { post: EDGE });
  const valid = boardRecord("task", "broken-post");
  await putBoard(f, good, boardKey("ask", "with-post"));
  await putBoard(f, edge, boardKey("task", "edge-post"));
  // The board's copy is the same record with a post over the limit; the run holds the valid index row.
  await putBoard(f, { ...valid, post: "a".repeat(281) }, boardKey("task", "broken-post"));
  const rows = [good, edge, valid].map((record) => ({ key: boardKey(record.kind, record.id), record: record as BoardRecord }));
  const results = await postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows, now: Date.parse(NOW) });
  expect(results.map((item) => [item.key, item.outcome, item.code])).toEqual([
    [boardKey("ask", "with-post"), "posted", undefined],
    [boardKey("task", "edge-post"), "posted", undefined],
    [boardKey("task", "broken-post"), "refused", "INVALID_INPUT"],
  ]);
  const cards = take(await listFeedCardHistory(f.output)).cards;
  expect(cards.map(payloadPost).sort()).toEqual([EDGE, GOOD].sort());
});
