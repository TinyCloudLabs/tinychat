/**
 * The mirror posts a board card to Home and then claims the board's copy. The board's live head decides whether that
 * claim may happen, so it is read before anything is written to Home: a card built from a stale cached body, while the
 * live board copy has moved on, is refused with nothing posted. (It was posted first and refused after, which left a
 * stale card in Home's feed.)
 */
import { afterEach, expect, test } from "bun:test";
import { listFeedCardHistory } from "@tinycloud/sdk-services/feed";
import { boardKey } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { postMany } from "./inventory";
import { homeMirrorBindings } from "./bridge";
import { boardRecord, mirrorNode, NOW, SOURCE, take } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function node(): Promise<MirrorNode> { const f = await mirrorNode(); cleanup.push(() => f.close()); return f; }

const ID = "stale-ask", KEY = boardKey("ask", ID);
const ask = (title: string): BoardRecord => boardRecord("ask", ID, { title });
const putBoard = async (f: MirrorNode, record: BoardRecord) => { take(await f.legacy.put(KEY, JSON.stringify(record), { prefix: "", contentType: "application/json" })); };
const post = (f: MirrorNode, record: BoardRecord) => postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: [{ key: KEY, record }], now: Date.parse(NOW) });
const homeCards = async (f: MirrorNode) => (await listFeedCardHistory(f.output).then(take)).cards.length;

test("a stale cached card is refused before Home is written when the live board copy is newer", async () => {
  const f = await node();
  await putBoard(f, ask("Newer, live"));
  const [result] = await post(f, ask("Older, cached"));
  expect(result).toMatchObject({ key: KEY, outcome: "refused" });
  expect(await homeCards(f)).toBe(0);
  expect(await homeMirrorBindings(f.ctx)).toEqual([]);
  expect(JSON.parse(f.values.get(KEY)!.text).title).toBe("Newer, live");
});

test("a card whose live board copy is the same record is still posted", async () => {
  const f = await node();
  await putBoard(f, ask("Same"));
  expect((await post(f, ask("Same")))[0]).toMatchObject({ outcome: "posted" });
  expect(await homeCards(f)).toBe(1);
});

test("a card the board has never held is still posted", async () => {
  const f = await node();
  expect((await post(f, ask("Brand new")))[0]).toMatchObject({ outcome: "posted" });
  expect(await homeCards(f)).toBe(1);
});
