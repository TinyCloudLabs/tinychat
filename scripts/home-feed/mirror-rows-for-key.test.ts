import { afterEach, expect, test } from "bun:test";
import { boardKey } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { homeMirrorBindings, homeMirrorBindingsFor, publishHomeMirror, readHomeMirrorSource } from "./bridge";
import type { HomeMirrorContext, HomeMirrorPublishInput } from "./bridge-types";
import { boardCard, postMany } from "./inventory";
import { boardRecord, mirrorNode, NOW, SOURCE } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";
import { take } from "./mirror-node.fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function node(): Promise<MirrorNode> { const f = await mirrorNode(); cleanup.push(() => f.close()); return f; }

const rowsOf = (records: BoardRecord[]) => records.map((record) => ({ key: boardKey(record.kind, record.id), record }));
async function mirrored(f: MirrorNode, records: BoardRecord[]) {
  for (const record of records) take(await f.legacy.put(boardKey(record.kind, record.id), JSON.stringify(record), { prefix: "", contentType: "application/json" }));
  await postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: rowsOf(records), now: Date.parse(NOW) });
  f.resetCalls();
}
/** The context with every statement that reaches the owner's table written down. */
function recording(f: MirrorNode, extra: Partial<HomeMirrorContext> = {}) {
  const statements: string[] = [];
  const ctx: HomeMirrorContext = {
    ...f.ctx, ...extra,
    sql: { db: (name: string) => {
      const database = f.ctx.sql.db(name);
      return new Proxy(database, { get: (target, property, receiver) => property === "query"
        ? (sql: string, params?: unknown[]) => { statements.push(sql); return target.query(sql, params as never); }
        : Reflect.get(target, property, receiver) });
    } },
  };
  return { ctx, statements, mirrorReads: () => statements.filter((sql) => sql.includes("feed_sitrep_mirrors")) };
}

test("the bindings of one key are the only ones read, and a filtered read never lands in the cache", async () => {
  const f = await node(), records = [boardRecord("ask", "a1"), boardRecord("ask", "a2"), boardRecord("task", "t1")];
  await mirrored(f, records);
  const key = boardKey("ask", "a2");
  const seen = recording(f, { cache: {} });
  const own = await homeMirrorBindingsFor(seen.ctx, key);
  expect(own.map((binding) => binding.legacy.fullKey)).toEqual([key]);
  expect(seen.mirrorReads()).toHaveLength(1);
  expect(seen.mirrorReads()[0]).toContain("WHERE");
  expect(seen.ctx.cache?.mirrors).toBeUndefined();
  // A second filtered read asks the node again: nothing was kept.
  await homeMirrorBindingsFor(seen.ctx, key);
  expect(seen.mirrorReads()).toHaveLength(2);
  // The full read still reads every row and is the only thing that fills the cache.
  expect((await homeMirrorBindings(seen.ctx)).map((binding) => binding.legacy.fullKey).sort()).toEqual(records.map((record) => boardKey(record.kind, record.id)).sort());
  expect(seen.ctx.cache?.mirrors).toHaveLength(3);
  expect(seen.mirrorReads()).toHaveLength(3);
});

test("with the full table cached, one key's bindings come from it without a node call and the cache keeps every row", async () => {
  const f = await node(), records = [boardRecord("ask", "a1"), boardRecord("ask", "a2")];
  await mirrored(f, records);
  const seen = recording(f, { cache: {} });
  await homeMirrorBindings(seen.ctx);
  const before = seen.mirrorReads().length;
  const own = await homeMirrorBindingsFor(seen.ctx, boardKey("ask", "a1"));
  expect(own.map((binding) => binding.legacy.fullKey)).toEqual([boardKey("ask", "a1")]);
  expect(seen.mirrorReads()).toHaveLength(before);
  expect(seen.ctx.cache?.mirrors).toHaveLength(2);
});

test("a key with no binding gives an empty list", async () => {
  const f = await node();
  await mirrored(f, [boardRecord("ask", "a1")]);
  expect(await homeMirrorBindingsFor(f.ctx, boardKey("ask", "never-mirrored"))).toEqual([]);
});

test("publishing a card reads only its own key's rows, and publishing it again finds its binding", async () => {
  const f = await node(), first = boardRecord("ask", "a1"), second = boardRecord("ask", "a2");
  await mirrored(f, [first]);
  take(await f.legacy.put(boardKey("ask", "a2"), JSON.stringify(second), { prefix: "", contentType: "application/json" }));
  const source = await readHomeMirrorSource(f.ctx, SOURCE);
  const row = rowsOf([second])[0]!;
  const input: HomeMirrorPublishInput = { source: { ...source, label: "Rocinante" }, card: boardCard(row, [second], Date.parse(NOW)), legacy: { spaceId: f.ctx.legacySpaceId, fullKey: row.key, record: second } };
  const seen = recording(f);
  const binding = await publishHomeMirror(seen.ctx, input);
  expect(seen.mirrorReads().filter((sql) => sql.startsWith("SELECT"))).not.toHaveLength(0);
  for (const sql of seen.mirrorReads().filter((statement) => statement.startsWith("SELECT"))) expect(sql).toContain("WHERE");
  expect(binding.legacy.fullKey).toBe(row.key);
  // The same card again is recognised as already bound: same binding, still one row for it.
  expect(await publishHomeMirror(seen.ctx, input)).toEqual(binding);
  expect((await homeMirrorBindingsFor(f.ctx, row.key))).toHaveLength(1);
  expect((await homeMirrorBindings(f.ctx))).toHaveLength(2);
});
