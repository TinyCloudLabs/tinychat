/**
 * A card answered where the mirror never sees the answer (on the board's own page) closes its board record, and Home
 * kept showing it as waiting on the owner. When a mirrored board record is closed on the board, the mirror posts the
 * next revision of its card with needsResponse false, so it leaves Needs you. A card the owner answered in Home is
 * left as it is: the Home answer already closes the board record, and the card is already answered.
 */
import { afterEach, expect, test } from "bun:test";
import { appendFeedResponse, listFeedCardHistory, publishFeedCard } from "@tinycloud/sdk-services/feed";
import { boardKey, parseSitrepCardPayload } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { homeMirrorBindings } from "./bridge";
import { boardCard, boardCardIdentity, closeFromBoard, postMany } from "./inventory";
import { boardRecord, mirrorNode, NOW, SOURCE, T1, take } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function node(): Promise<MirrorNode> { const f = await mirrorNode(); cleanup.push(() => f.close()); return f; }

const NOW_MS = Date.parse(NOW);
const CODE_URL = "https://openkey.so/delegate?user_code=ABCD-1234&state=keep-out-of-history";
const BARE_URL = "https://openkey.so/delegate";
const row = (record: BoardRecord) => ({ key: boardKey(record.kind, record.id), record });
const put = async (f: MirrorNode, record: BoardRecord) => { take(await f.legacy.put(boardKey(record.kind, record.id), JSON.stringify(record), { prefix: "", contentType: "application/json" })); };
/** The card is in Home and bound, as after a post-many pass. */
async function mirrored(f: MirrorNode, record: BoardRecord) {
  await put(f, record);
  expect((await postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: [row(record)], now: NOW_MS }))[0]).toMatchObject({ outcome: "posted" });
}
const close = (f: MirrorNode, closed: BoardRecord[]) => closeFromBoard(f.ctx, { sourceId: SOURCE, rows: closed.map(row), now: NOW_MS });
const history = async (f: MirrorNode) => take(await listFeedCardHistory(f.output)).cards.sort((a, b) => a.revision - b.revision);

test("a mirrored ask closed on the board gets a closing revision that no longer needs the owner", async () => {
  const f = await node();
  const open = boardRecord("ask", "q1");
  await mirrored(f, open);
  expect((await history(f))[0]).toMatchObject({ revision: 1, needsResponse: true });
  const answered = boardRecord("ask", "q1", { status: "answered" });
  expect((await close(f, [answered]))[0]).toMatchObject({ key: boardKey("ask", "q1"), outcome: "closed" });
  const cards = await history(f);
  expect(cards.map((card) => [card.cardId, card.revision, card.needsResponse])).toEqual([[cards[0]!.cardId, 1, true], [cards[0]!.cardId, 2, false]]);
  expect(cards[1]!.issuanceId).not.toBe(cards[0]!.issuanceId);
  expect(parseSitrepCardPayload(cards[1]!.payload?.sitrep)?.record).toMatchObject({ kind: "ask", id: "q1", status: "answered" });
  // The binding and the board's copy are as the mirror left them.
  expect((await homeMirrorBindings(f.ctx)).map((binding) => binding.identity.revision)).toEqual([1]);
});

test("a second pass over the same closed record posts nothing more", async () => {
  const f = await node();
  await mirrored(f, boardRecord("task", "t1"));
  const done = boardRecord("task", "t1", { status: "done" });
  expect((await close(f, [done]))[0]).toMatchObject({ outcome: "closed" });
  expect((await close(f, [done]))[0]).toMatchObject({ outcome: "already" });
  expect(await history(f)).toHaveLength(2);
});

test("a closed approval reaches Home as a closing revision without its consent code", async () => {
  const f = await node();
  // Through JSON, as a board copy is read back (an undefined field is a missing one).
  const copy = (record: BoardRecord): BoardRecord => JSON.parse(JSON.stringify(record));
  const fields = { approvalType: "openkey", approvalKind: undefined, codeExpected: true, issuedAt: "2026-11-13T09:30:00.000Z", url: CODE_URL, expiresAt: "2026-11-13T11:00:00.000Z" };
  const open = copy(boardRecord("approval", "g1", fields));
  await mirrored(f, open);
  const done = copy(boardRecord("approval", "g1", { ...fields, status: "done" }));
  expect((await close(f, [done]))[0]).toMatchObject({ outcome: "closed" });
  const latest = (await history(f)).at(-1)!;
  expect(latest).toMatchObject({ revision: 2, needsResponse: false });
  const typed = parseSitrepCardPayload(latest.payload?.sitrep);
  expect(typed?.record.kind === "approval" && typed.record.url).toBe(BARE_URL);
});

test("a card the owner answered in Home is left as it is", async () => {
  const f = await node();
  await mirrored(f, boardRecord("ask", "q2"));
  const [card] = await history(f);
  take(await appendFeedResponse(f.output, f.responses, { cardId: card!.cardId, revision: card!.revision, issuanceId: card!.issuanceId, responseId: "11111111-1111-4111-8111-111111111111", kind: "answer", choiceId: "yes", text: "You chose Proceed", createdAt: T1 }, { type: "sitrep.answer", version: 1, data: {} }));
  expect((await close(f, [boardRecord("ask", "q2", { status: "answered" })]))[0]).toMatchObject({ outcome: "answered-in-home" });
  expect(await history(f)).toHaveLength(1);
});

test("a closed board record that was never mirrored, and one still open, post nothing", async () => {
  const f = await node();
  await mirrored(f, boardRecord("ask", "q3"));
  const results = await close(f, [boardRecord("ask", "never-mirrored", { status: "answered" }), boardRecord("ask", "q3")]);
  expect(results.map((result) => result.outcome)).toEqual(["not-mirrored", "still-open"]);
  expect(await history(f)).toHaveLength(1);
});

test("a bound card whose record id is itself a secret is refused, and named by neither its id nor its board key", async () => {
  const f = await node();
  const id = `lin_api_${"k".repeat(30)}`, key = boardKey("ask", id);
  // Bound by an earlier pass, before the secret pattern existed.
  const safe = boardRecord("ask", "bound-earlier");
  const identity = boardCardIdentity(key);
  take(await publishFeedCard(f.output, { ...boardCard(row(safe), [safe], NOW_MS), ...identity }));
  const binding = { version: 1, source: f.source, identity, cardUuid: identity.cardId, legacy: { spaceId: f.ctx.legacySpaceId, fullKey: key, kind: "ask", id, publicationSha256: "0".repeat(64), publishedETag: "\"fixture\"" } };
  take(await f.owner.execute("INSERT INTO feed_sitrep_mirrors(source_id,card_id,revision,issuance_id,binding_json) VALUES (?,?,?,?,?)", [SOURCE, identity.cardId, identity.revision, identity.issuanceId, JSON.stringify(binding)]));
  const results = await close(f, [boardRecord("ask", id, { status: "answered" })]);
  expect(results).toEqual([{ key: "(key withheld)", kind: "ask", cardId: identity.cardId, outcome: "refused", code: "INVALID_INPUT", detail: "ask/(id withheld): a Linear API key" }]);
  expect(JSON.stringify(results)).not.toContain("kkkkkk");
  expect(await history(f)).toHaveLength(1);
});
