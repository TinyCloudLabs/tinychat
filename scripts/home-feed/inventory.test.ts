import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFeedCardHistory } from "@tinycloud/sdk-services/feed";
import { boardKey } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord, Kind } from "@tinyboilerplate/core/feed/sitrep";
import { boardCard, boardCardIdentity, inventoryPlan, parseInventoryKinds, postMany, readBoardIndex, uuidV5 } from "./inventory";
import { boardRecord, mirrorNode, NOW, SOURCE, take } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function node(): Promise<MirrorNode> { const f = await mirrorNode(); cleanup.push(() => f.close()); return f; }
async function directory(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "home-inventory-")); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir; }

type IndexRow = { key: string; kind: string; id: string; json: string | null; closed?: number; created?: number };
/** The columns roci-board's board-index.sqlite `records` table has that the builder reads. */
function writeIndex(path: string, rows: IndexRow[]) {
  const db = new Database(path);
  db.exec("CREATE TABLE records (key TEXT PRIMARY KEY, etag TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, kind TEXT NOT NULL, closed INTEGER NOT NULL, created_ms INTEGER NOT NULL, record_json TEXT)");
  for (const row of rows) db.query("INSERT INTO records (key,id,kind,closed,created_ms,record_json) VALUES (?,?,?,?,?,?)").run(row.key, row.id, row.kind, row.closed ?? 0, row.created ?? 0, row.json);
  db.close();
}
const indexRow = (record: BoardRecord, extra: Record<string, unknown> = {}, created = 0): IndexRow =>
  ({ key: boardKey(record.kind, record.id), kind: record.kind, id: record.id, json: JSON.stringify({ ...record, ...extra }), created });

test("card ids are RFC 4122 name-based (v5) UUIDs of the board key, the same on every run", () => {
  // The RFC 4122 appendix vector: the DNS namespace and "www.example.com".
  expect(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  const key = boardKey("ask", "julie-hold-2026-11"), first = boardCardIdentity(key), second = boardCardIdentity(key);
  expect(first).toEqual(second);
  expect(first.cardId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(boardCardIdentity(boardKey("ask", "another-ask")).cardId).not.toBe(first.cardId);
  expect(first.issuanceId).not.toBe(first.cardId);
});

test("the plan has the open asks, tasks, incidents, progress and work, and says why it left each other row out", async () => {
  const path = join(await directory(), "board-index.sqlite");
  const open: BoardRecord[] = [boardRecord("ask", "a1"), boardRecord("task", "t1"), boardRecord("incident", "i1"), boardRecord("progress", "p1"), boardRecord("work", "w1")];
  const answered = boardRecord("ask", "a-done", { status: "answered", closedAt: NOW });
  const mine = boardRecord("ask", "a-mirrored"), elsewhere = boardRecord("ask", "a-elsewhere");
  writeIndex(path, [
    ...open.map((record, index) => indexRow(record, {}, index)),
    indexRow(answered, {}, 10),
    indexRow(mine, { cardUuid: boardCardIdentity(boardKey("ask", mine.id)).cardId }, 11),
    indexRow(elsewhere, { cardUuid: "00000000-0000-4000-8000-000000000000" }, 12),
    indexRow(boardRecord("approval", "ap1")), indexRow(boardRecord("hold", "h1")),
    { key: boardKey("ask", "broken"), kind: "ask", id: "broken", json: "{not json", created: 13 },
    { ...indexRow(boardRecord("ask", "a2"), {}, 14), key: boardKey("ask", "other-key") },
  ]);
  const { rows, skipped } = readBoardIndex(path, parseInventoryKinds(undefined));
  expect(rows.map((row) => row.key)).toEqual([...open, mine].map((record) => boardKey(record.kind, record.id)));
  expect(skipped).toEqual([
    { key: boardKey("ask", answered.id), reason: "closed" },
    { key: boardKey("ask", elsewhere.id), reason: "bound-elsewhere" },
    { key: boardKey("ask", "broken"), reason: "unreadable" },
    { key: boardKey("ask", "other-key"), reason: "key-mismatch" },
  ]);
  const plan = inventoryPlan(rows, Date.parse(NOW));
  expect(plan.refused).toEqual([]);
  expect(plan.items.map((item) => [item.kind, item.id, item.cardId])).toEqual(rows.map((row) => [row.record.kind, row.record.id, boardCardIdentity(row.key).cardId]));
  expect(plan.items.find((item) => item.id === "a1")?.needsResponse).toBe(true);
  expect(inventoryPlan(rows, Date.parse(NOW))).toEqual(plan);
});

test("approvals, holds and claims stay on the board: asking for them is refused", () => {
  for (const kinds of ["approval", "ask,hold", "claim"]) expect(() => parseInventoryKinds(kinds)).toThrow("Home mirror inventory leaves approvals, holds and claims on the board");
  expect(parseInventoryKinds("task,ask,task")).toEqual(["task", "ask"]);
});

test("a dry run prints the plan with no owner session or node: only the index is read", async () => {
  const dir = await directory(), path = join(dir, "board-index.sqlite");
  writeIndex(path, [indexRow(boardRecord("ask", "a1")), indexRow(boardRecord("task", "t1"), {}, 1)]);
  const space = "tinycloud:pkh:eip155:1:0x6666666666666666666666666666666666666666:applications";
  // No profile, home or host exists: a dry run that opened a session or reached a node would fail.
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "run.ts"), "post-many", "--dry-run", "--from-index", path, "--source", SOURCE, "--owner-space", space, "--legacy-space", space],
    { env: { ...process.env, HOME: join(dir, "no-home"), TC_HOME: join(dir, "no-home") }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(exit).toBe(0);
  const out = JSON.parse(stdout);
  expect(out).toMatchObject({ operation: "post-many", dryRun: true, planned: 2, skipped: [] });
  expect(out.items.map((item: { id: string }) => item.id)).toEqual(["a1", "t1"]);
});

async function seedBoard(f: MirrorNode, records: BoardRecord[]) {
  for (const record of records) take(await f.legacy.put(boardKey(record.kind, record.id), JSON.stringify(record), { prefix: "", contentType: "application/json" }));
  f.resetCalls();
}
const rowsOf = (records: BoardRecord[]) => records.map((record) => ({ key: boardKey(record.kind, record.id), record }));

test("post-many reads the registry and mirror table once, posts each card in order, and costs the same per card", async () => {
  const counts: number[] = [];
  for (const size of [1, 4]) {
    const f = await node();
    const records = Array.from({ length: size }, (_, index) => boardRecord((["ask", "task", "incident", "work"] as Kind[])[index % 4]!, `card-${index}`));
    await seedBoard(f, records);
    const results = await postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: rowsOf(records), now: Date.parse(NOW) });
    expect(results.map((item) => item.outcome)).toEqual(records.map(() => "posted"));
    const calls = f.calls();
    expect(calls.filter((call) => call.endsWith(":home_feed") && call.startsWith("sql:query")).length).toBe(2 + size); // registry, table, one read-back per post
    counts.push(calls.length);
    expect(take(await listFeedCardHistory(f.output)).cards.map((card) => card.cardId).sort()).toEqual(records.map((record) => boardCardIdentity(boardKey(record.kind, record.id)).cardId).sort());
    for (const record of records) expect(JSON.parse(f.values.get(boardKey(record.kind, record.id))!.text).cardUuid).toBe(boardCardIdentity(boardKey(record.kind, record.id)).cardId);
  }
  // Two reads for the run, then a fixed number per card, whatever the inventory size.
  const perCard = (counts[1]! - counts[0]!) / 3;
  expect(Number.isInteger(perCard)).toBe(true);
  expect(counts[0]).toBe(2 + perCard);
});

test("a re-run posts nothing and costs two reads; a card whose board record changed is reported, not re-posted", async () => {
  const f = await node(), records = [boardRecord("ask", "a1"), boardRecord("task", "t1")];
  await seedBoard(f, records);
  await postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: rowsOf(records), now: Date.parse(NOW) });
  f.resetCalls();
  const again = await postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: rowsOf(records), now: Date.parse(NOW) });
  expect(again.map((item) => item.outcome)).toEqual(["already", "already"]);
  expect(f.calls()).toEqual(["sql:query:home_feed", "sql:query:home_feed"]);
  const changed = [{ ...records[0]!, title: "A new title" } as BoardRecord, records[1]!];
  f.resetCalls();
  const third = await postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: rowsOf(changed), now: Date.parse(NOW) });
  expect(third.map((item) => item.outcome)).toEqual(["changed", "already"]);
  expect(f.calls()).toHaveLength(2);
  expect(take(await listFeedCardHistory(f.output)).cards).toHaveLength(2);
});

test("one card the mirror refuses is reported with its code and the rest are still posted", async () => {
  const f = await node(), records = [boardRecord("ask", "a1"), boardRecord("task", "t1")];
  await seedBoard(f, records);
  // The board copy of a1 no longer matches the index: the mirror must not overwrite it.
  take(await f.legacy.put(boardKey("ask", "a1"), JSON.stringify({ ...records[0], title: "Edited on the board" }), { prefix: "", contentType: "application/json" }));
  const results = await postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: rowsOf(records), now: Date.parse(NOW) });
  expect(results.map((item) => [item.key, item.outcome])).toEqual([[boardKey("ask", "a1"), "refused"], [boardKey("task", "t1"), "posted"]]);
  expect(results[0]!.code).toBe("KV_PRECONDITION_FAILED");
  expect(JSON.parse(f.values.get(boardKey("ask", "a1"))!.text).title).toBe("Edited on the board");
});

test("postMany and boardCard leave approvals, holds and claims on the board even when a caller passes them", async () => {
  const f = await node();
  const approval = boardRecord("approval", "g1"), hold = boardRecord("hold", "h1"), ask = boardRecord("ask", "a1");
  await seedBoard(f, [approval, hold, ask]);
  for (const record of [approval, hold]) expect(() => boardCard({ key: boardKey(record.kind, record.id), record }, [record], Date.parse(NOW))).toThrow("Home mirror inventory leaves approvals, holds and claims on the board");
  f.resetCalls();
  const results = await postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: rowsOf([approval, hold, ask]), now: Date.parse(NOW) });
  expect(results.map((item) => [item.key, item.outcome, item.code])).toEqual([
    [boardKey("approval", "g1"), "refused", "INVALID_INPUT"], [boardKey("hold", "h1"), "refused", "INVALID_INPUT"], [boardKey("ask", "a1"), "posted", undefined],
  ]);
  expect(take(await listFeedCardHistory(f.output)).cards.map((card) => card.kind)).toEqual(["ask"]);
});
