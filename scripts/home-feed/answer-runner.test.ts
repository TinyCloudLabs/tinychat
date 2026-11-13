import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { appendFeedMessage, appendFeedResponse, projectFeedResponseNotification, readFeedResponseHandling } from "@tinycloud/sdk-services/feed";
import type { FeedCard, FeedResponse, FeedResponsePayload } from "@tinycloud/sdk-services/feed";
import { answerKey, boardKey, stateKey } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord, Kind } from "@tinyboilerplate/core/feed/sitrep";
import { handedOffResponse, runAnswerRunner, runnerLogLine, writeThroughResponse } from "./answer-runner";
import { publishHomeMirror } from "./bridge";
import { boardCard } from "./inventory";
import { boardRecord, mirrorNode, NOW, SOURCE, T1, take } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";

const PRIVATE = "SYNTHETIC-APPROVAL-CODE-7731";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function mirrored(kind: Kind) {
  const f = await mirrorNode(); cleanup.push(() => f.close());
  const record: BoardRecord = boardRecord(kind, `runner-${kind}`), key = boardKey(kind, record.id);
  take(await f.legacy.put(key, JSON.stringify(record), { prefix: "", contentType: "application/json" }));
  const card = boardCard({ key, record }, [record], Date.parse(NOW));
  await publishHomeMirror(f.ctx, { source: { ...f.source, label: "Rocinante" }, card, legacy: { spaceId: f.space, fullKey: key, record } });
  f.resetCalls();
  return { f, record, card };
}
const identity = (card: FeedCard) => ({ cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId });
async function answer(f: MirrorNode, card: FeedCard, data: FeedResponsePayload["data"]) {
  return take(await appendFeedResponse(f.output, f.responses, { ...identity(card), responseId: randomUUID(), kind: "answer", choiceId: "yes", text: "You chose Proceed", createdAt: T1 }, { type: "sitrep.answer", version: 1, data }));
}
async function message(f: MirrorNode, card: FeedCard, payload: FeedResponsePayload) {
  return take(await appendFeedMessage(f.output, f.responses, { ...identity(card), responseId: randomUUID(), kind: "message", text: "A note", createdAt: T1 }, payload));
}
const header = (response: FeedResponse) => handedOffResponse.parse(projectFeedResponseNotification(response));
const kvWrites = (f: MirrorNode) => f.calls().filter((call) => call === "kv:put").length;

test("an answer is written where the board's watcher reads Sam's answers, then Home is told it was received", async () => {
  const { f, record, card } = await mirrored("ask");
  const data = { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 };
  const response = await answer(f, card, data);
  const result = await writeThroughResponse(f.ctx, { sourceId: SOURCE, header: header(response) });
  expect(result).toEqual({ wrote: "answer", key: answerKey(record.id, T1), stored: "written", received: "recorded" });
  expect(JSON.parse(f.values.get(answerKey(record.id, T1))!.text)).toEqual(data);
  const handling = take(await readFeedResponseHandling(f.output, { ...identity(card), responseId: response.responseId }));
  expect(handling.acknowledgement).toMatchObject({ responseId: response.responseId, phase: "acknowledged", handlingId: `${response.responseId}:acknowledged` });
  expect(handling.outcome).toBeNull();
});

test("running again for the same response writes nothing new", async () => {
  const { f, record, card } = await mirrored("ask");
  const response = await answer(f, card, { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 });
  await writeThroughResponse(f.ctx, { sourceId: SOURCE, header: header(response) });
  f.resetCalls();
  const again = await writeThroughResponse(f.ctx, { sourceId: SOURCE, header: header(response) });
  expect(again).toMatchObject({ stored: "already", received: "already" });
  expect(kvWrites(f)).toBe(0);
  expect(f.calls().filter((call) => call.startsWith("sql:execute") || call.startsWith("sql:batch"))).toEqual([]);
});

test("a task marked done in Home is merged into the card's saved state, keeping what Sam saved before", async () => {
  const { f, record, card } = await mirrored("task");
  const key = stateKey("task", record.id), earlier = { kind: "task", id: record.id, steps: { one: NOW }, updatedAt: NOW, notes: [{ id: "note00001", at: NOW, text: "Keep the old note" }] };
  take(await f.legacy.put(key, JSON.stringify(earlier), { prefix: "", contentType: "application/json" }));
  const doneAt = "2026-11-13T11:00:00.000Z";
  const response = await message(f, card, { type: "sitrep.state", version: 1, data: { kind: "task", id: record.id, steps: {}, updatedAt: doneAt, doneAt } });
  const result = await writeThroughResponse(f.ctx, { sourceId: SOURCE, header: header(response) });
  expect(result).toMatchObject({ wrote: "state", key, stored: "written", received: "recorded" });
  expect(JSON.parse(f.values.get(key)!.text)).toMatchObject({ kind: "task", id: record.id, doneAt, steps: { one: NOW }, notes: [{ id: "note00001", text: "Keep the old note" }] });
});

test("a different answer already stored under the same key is left as it is and nothing is acknowledged", async () => {
  const { f, record, card } = await mirrored("ask");
  take(await f.legacy.put(answerKey(record.id, T1), JSON.stringify({ askId: record.id, action: "drop", text: "", at: T1 }), { prefix: "", contentType: "application/json" }));
  const response = await answer(f, card, { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 });
  await expect(writeThroughResponse(f.ctx, { sourceId: SOURCE, header: header(response) })).rejects.toThrow("The board already holds a different answer for this response");
  expect(JSON.parse(f.values.get(answerKey(record.id, T1))!.text).action).toBe("drop");
  expect((await readFeedResponseHandling(f.output, { ...identity(card), responseId: response.responseId })).ok).toBe(false);
});

test("a comment or a card action is not written through: no board write, no acknowledgement", async () => {
  const { f, card } = await mirrored("ask");
  const action = await message(f, card, { type: "feed.acknowledge", version: 1, data: {} });
  await expect(writeThroughResponse(f.ctx, { sourceId: SOURCE, header: header(action) })).rejects.toThrow("This response is not one the runner writes through");
  expect(kvWrites(f)).toBe(0);
  expect((await readFeedResponseHandling(f.output, { ...identity(card), responseId: action.responseId })).ok).toBe(false);
});

test("the header on stdin grants nothing: a response the owner's database does not hold is refused", async () => {
  const { f, record, card } = await mirrored("ask");
  const response = await answer(f, card, { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 });
  const forged = { ...header(response), responseId: randomUUID() };
  await expect(writeThroughResponse(f.ctx, { sourceId: SOURCE, header: forged })).rejects.toThrow();
  const otherCard = { ...header(response), cardId: randomUUID() };
  await expect(writeThroughResponse(f.ctx, { sourceId: SOURCE, header: otherCard })).rejects.toThrow();
  expect(kvWrites(f)).toBe(0);
});

test("the log line has ids and times only, never what the owner wrote or a code", async () => {
  const { f, record, card } = await mirrored("ask");
  const response = await answer(f, card, { askId: record.id, action: "answer", text: PRIVATE, at: T1 });
  const handed = { ...header(response), text: PRIVATE };
  const result = await writeThroughResponse(f.ctx, { sourceId: SOURCE, header: handed });
  const start = "2026-11-13T09:00:07.500Z";
  const line = runnerLogLine(start, handed, { result });
  expect(line).not.toContain(PRIVATE);
  expect(JSON.parse(line)).toEqual({ at: start, responseId: response.responseId, cardId: card.cardId, createdAt: T1, pickupMs: 7500, wrote: "answer", stored: "written", received: "recorded" });
  const failed = runnerLogLine(start, handed, { code: "KV_PRECONDITION_FAILED" });
  expect(failed).not.toContain(PRIVATE);
  expect(JSON.parse(failed)).toMatchObject({ responseId: response.responseId, error: "KV_PRECONDITION_FAILED" });
  expect(inspect(f.values.get(answerKey(record.id, T1)))).toContain(PRIVATE); // the code reaches the board, as from sitrep
});

test("the runner exits non-zero without a source, spaces or a response on stdin", async () => {
  const errors: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    expect(await runAnswerRunner([], async () => "{}")).toBe(2);
    expect(await runAnswerRunner(["--tc-home", "/x", "--profile", "p", "--owner-space", "a", "--legacy-space", "b", "--source", SOURCE, "--log", "/dev/null"], async () => JSON.stringify({ text: PRIVATE }))).toBe(2);
  } finally { process.stderr.write = write; }
  expect(errors.join("")).not.toContain(PRIVATE);
  expect(JSON.parse(errors[0]!)).toMatchObject({ error: { code: "INVALID_INPUT", step: "arguments" }, delivery: "not-confirmed" });
});
