import { expect, spyOn, test } from "bun:test";
import type { FeedDatabase } from "@tinycloud/sdk-services/feed";
import { cardMdVersion, migrateCardMd, readCardMd, saveCardMd } from "./cardMd";
import { CARD_MD_DEFAULT } from "./cardMdDefault";
import { sqliteFeedDatabase } from "./cardMdSqlite.fixture";

const at = new Date("2026-11-21T10:00:00.000Z");
const wroteAt = new Date("2026-11-19T02:00:00.000Z");

const count = async (db: FeedDatabase) => {
  const result = await db.query<number>("SELECT COUNT(*) FROM card_md");
  return result.ok ? Number(result.data.rows[0]![0]) : -1;
};

test("an old row with the wrong version keeps its text in the master, with the version recomputed, and the default is not seeded", async () => {
  const master = sqliteFeedDatabase();
  const legacy = sqliteFeedDatabase();
  await saveCardMd(legacy, "Original text.", wroteAt);
  await legacy.execute("UPDATE card_md SET text = 'Rewritten text.' WHERE id = 1");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await migrateCardMd(master, legacy, at)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("did not match");
    expect(String(warn.mock.calls[0]![0])).not.toContain("Rewritten text.");
  } finally { warn.mockRestore(); }

  const carried = await readCardMd(master);
  expect(carried).toEqual({ text: "Rewritten text.", version: cardMdVersion("Rewritten text."), updatedAt: wroteAt.toISOString() });
  expect(carried?.text).not.toBe(CARD_MD_DEFAULT);
  expect(await count(legacy)).toBe(0);
});

test("a second run after a carried-over mismatch changes nothing and logs nothing", async () => {
  const master = sqliteFeedDatabase();
  const legacy = sqliteFeedDatabase();
  await saveCardMd(legacy, "Original text.", wroteAt);
  await legacy.execute("UPDATE card_md SET text = 'Rewritten text.' WHERE id = 1");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await migrateCardMd(master, legacy, at);
    const first = await readCardMd(master);
    warn.mockClear();

    expect(await migrateCardMd(master, legacy, new Date("2026-11-22T10:00:00.000Z"))).toBe(true);
    expect(await readCardMd(master)).toEqual(first);
    expect(await count(master)).toBe(1);
    expect(await count(legacy)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

test("the old row is deleted only after the master holds the carried-over text", async () => {
  const legacy = sqliteFeedDatabase();
  await saveCardMd(legacy, "Original text.", wroteAt);
  await legacy.execute("UPDATE card_md SET text = 'Rewritten text.' WHERE id = 1");
  const real = sqliteFeedDatabase();
  let stores = false;
  // Every call answers ok; a write stores nothing until `stores` is turned on.
  const master = {
    query: real.query.bind(real),
    batch: real.batch.bind(real),
    execute: (sql: string, params?: unknown[]) => stores ? real.execute(sql, params) : Promise.resolve({ ok: true, data: { changes: 0, lastInsertRowId: 0 } }),
  } as unknown as FeedDatabase;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await migrateCardMd(master, legacy, at)).toBe(false);
    expect(await count(legacy)).toBe(1);

    stores = true;
    expect(await migrateCardMd(master, legacy, at)).toBe(true);
  } finally { warn.mockRestore(); }
  expect((await readCardMd(master))?.text).toBe("Rewritten text.");
  expect(await count(legacy)).toBe(0);
});
