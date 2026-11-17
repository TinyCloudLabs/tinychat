/**
 * A board card is published to Home as revision 1, and the board is cut over to it (its binding and `cardUuid`) only
 * after. If the board card is edited in between, the pass that follows rebuilds revision 1 with the new content; Home's
 * revision 1 cannot change, so that pass was refused on every run and the card stayed stranded. The mirror posts the
 * edit as the next revision instead.
 */
import { afterEach, expect, test } from "bun:test";
import { listFeedCardHistory, publishFeedCard } from "@tinycloud/sdk-services/feed";
import { boardKey } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { boardCard, postMany } from "./inventory";
import { homeMirrorBindings } from "./bridge";
import { boardRecord, mirrorNode, NOW, SOURCE, take } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function node(): Promise<MirrorNode> { const f = await mirrorNode(); cleanup.push(() => f.close()); return f; }

const ID = "edited-ask", KEY = boardKey("ask", ID);
const edited = (title: string): BoardRecord => boardRecord("ask", ID, { title });
const row = (record: BoardRecord) => ({ key: KEY, record });
const putBoard = async (f: MirrorNode, record: BoardRecord) => { take(await f.legacy.put(KEY, JSON.stringify(record), { prefix: "", contentType: "application/json" })); };
/** What an earlier pass did before it stopped: the card is in Home, the board has no binding and no `cardUuid`. */
async function strandedAt(f: MirrorNode, record: BoardRecord) {
  take(await publishFeedCard(f.output, boardCard(row(record), [record], Date.parse(NOW))));
}
const post = (f: MirrorNode, record: BoardRecord) => postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: [row(record)], now: Date.parse(NOW) });
const homeTitles = async (f: MirrorNode) => (await listFeedCardHistory(f.output).then(take)).cards.map((card) => [card.revision, card.title]).sort();

test("a board card edited after it reached Home and before its cutover is posted as the next revision, and bound to it", async () => {
  const f = await node();
  await strandedAt(f, edited("Before the edit"));
  await putBoard(f, edited("After the edit"));
  const [result] = await post(f, edited("After the edit"));
  expect(result).toMatchObject({ key: KEY, outcome: "posted" });
  expect(await homeTitles(f)).toEqual([[1, "Before the edit"], [2, "After the edit"]]);
  const bindings = await homeMirrorBindings(f.ctx);
  expect(bindings.map((binding) => [binding.legacy.fullKey, binding.identity.revision])).toEqual([[KEY, 2]]);
  expect(JSON.parse(f.values.get(KEY)!.text).cardUuid).toBe(bindings[0]!.cardUuid);
  // The next pass finds it mirrored and posts nothing more.
  expect((await post(f, edited("After the edit")))[0]).toMatchObject({ outcome: "already" });
  expect(await homeTitles(f)).toHaveLength(2);
});

test("a card stranded with the same content is posted again as the same revision, not a new one", async () => {
  const f = await node();
  await strandedAt(f, edited("Unchanged"));
  await putBoard(f, edited("Unchanged"));
  expect((await post(f, edited("Unchanged")))[0]).toMatchObject({ outcome: "posted" });
  expect(await homeTitles(f)).toEqual([[1, "Unchanged"]]);
  expect((await homeMirrorBindings(f.ctx)).map((binding) => binding.identity.revision)).toEqual([1]);
});

test("a pass that stopped after posting the edit as revision 2 finishes that revision instead of posting a third", async () => {
  const f = await node();
  await strandedAt(f, edited("First"));
  const second = edited("Second");
  take(await publishFeedCard(f.output, { ...boardCard(row(second), [second], Date.parse(NOW)), revision: 2, issuanceId: "00000000-0000-4000-8000-000000000002" }));
  await putBoard(f, second);
  expect((await post(f, second))[0]).toMatchObject({ outcome: "posted" });
  expect(await homeTitles(f)).toEqual([[1, "First"], [2, "Second"]]);
  expect((await homeMirrorBindings(f.ctx)).map((binding) => binding.identity.revision)).toEqual([2]);
});

test("a card that is already bound and then edited is still reported as changed, not posted again", async () => {
  const f = await node();
  await putBoard(f, edited("Bound"));
  expect((await post(f, edited("Bound")))[0]).toMatchObject({ outcome: "posted" });
  expect((await post(f, edited("Bound, edited")))[0]).toMatchObject({ outcome: "changed" });
  expect(await homeTitles(f)).toEqual([[1, "Bound"]]);
});
