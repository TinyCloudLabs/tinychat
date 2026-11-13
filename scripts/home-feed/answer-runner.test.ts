import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  appendFeedMessage, appendFeedResponse, listFeedResponseDeliveries, listFeedResponses, projectFeedResponseNotification, readFeedResponseHandling, restoreFeedRecords,
} from "@tinycloud/sdk-services/feed";
import type { FeedCard, FeedResponse, FeedResponsePayload, FeedRestoreDeliveryPolicy, FeedRestoreOrigin } from "@tinycloud/sdk-services/feed";
import { SAM_THREAD_PREFIX, answerKey, boardKey, compactStamp, parseThreadMessage, safeSitrepActionSummary, stateKey, threadKey, validateSitrepAction } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord, Kind } from "@tinyboilerplate/core/feed/sitrep";
import { handedOffResponse, runAnswerRunner, runnerLogLine, writeThroughResponse } from "./answer-runner";
import { drainHomeMirrorResponses, publishHomeMirror } from "./bridge";
import type { HomeMirrorContext } from "./bridge-types";
import { boardCard } from "./inventory";
import { boardRecord, mirrorNode, NOW, SOURCE, SPACE, T0, T1, take } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";

const PRIVATE = "SYNTHETIC-APPROVAL-CODE-7731";
const RUNNER = "roci-runner";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function published(f: MirrorNode, card: FeedCard, record: BoardRecord) {
  const key = boardKey(record.kind, record.id);
  take(await f.legacy.put(key, JSON.stringify(record), { prefix: "", contentType: "application/json" }));
  await publishHomeMirror(f.ctx, { source: { ...f.source, label: "Rocinante" }, card, legacy: { spaceId: f.space, fullKey: key, record } });
  f.resetCalls();
}
async function mirrored(kind: Kind) {
  const f = await mirrorNode(); cleanup.push(() => f.close());
  const record: BoardRecord = boardRecord(kind, `runner-${kind}`);
  const card = boardCard({ key: boardKey(kind, record.id), record }, [record], Date.parse(NOW));
  await published(f, card, record);
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
const through = (f: MirrorNode, response: FeedResponse, ctx: HomeMirrorContext = f.ctx) => writeThroughResponse(ctx, { sourceId: SOURCE, recipient: RUNNER, header: header(response) });
const handled = async (f: MirrorNode, card: FeedCard, response: FeedResponse) => (await readFeedResponseHandling(f.output, { ...identity(card), responseId: response.responseId })).ok;

/** The runner's argv as a watch config names it, and an owner session that is the fixture's. */
const runnerArgs = (log: string) => ["--tc-home", "/unused", "--profile", "qa", "--owner-space", SPACE, "--legacy-space", SPACE, "--source", SOURCE, "--recipient", RUNNER, "--log", log];
const session = (f: MirrorNode) => async () => ({ ctx: f.ctx });
async function quietly<T>(run: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
  const errors: string[] = [], write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { value: await run(), errors }; } finally { process.stderr.write = write; }
}

const policy = (origin: FeedRestoreOrigin, patch: Partial<FeedRestoreDeliveryPolicy> = {}): FeedRestoreDeliveryPolicy =>
  ({ recipient: RUNNER, state: "pending", dispatch: "resolved-pending", resolvedOwnerMapping: true, dispatchBefore: null, source: origin, ...patch });
/** An answer restored from the board's history with these delivery policies (none: the default, never dispatched). */
async function restored(f: MirrorNode, card: FeedCard, data: FeedResponsePayload["data"], policies: (origin: FeedRestoreOrigin) => FeedRestoreDeliveryPolicy[]): Promise<FeedResponse> {
  const responseId = randomUUID();
  const origin: FeedRestoreOrigin = { sourceSpaceId: f.space, namespace: "xyz.tinycloud.rocinante", snapshotId: "synthetic-snapshot", sourceKey: `sam/answers/synthetic/${responseId}.json` };
  take(await restoreFeedRecords({ output: f.output, responses: f.responses }, { cards: [], responses: [{
    response: { ...identity(card), responseId, kind: "answer", choiceId: "yes", text: "You chose Proceed", createdAt: T1 },
    payload: { type: "sitrep.answer", version: 1, data }, origin, deliveries: policies(origin),
  }] }));
  const saved = take(await listFeedResponses(f.responses, { afterSequence: 0, limit: 1000 })).find((item) => item.responseId === responseId);
  if (!saved) throw new Error("restored response missing");
  return saved;
}

test("an answer is written where the board's watcher reads Sam's answers, then Home is told it was received", async () => {
  const { f, record, card } = await mirrored("ask");
  const data = { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 };
  const response = await answer(f, card, data);
  const result = await through(f, response);
  expect(result).toEqual({ wrote: "answer", key: answerKey(record.id, T1), stored: "written", received: "recorded" });
  expect(JSON.parse(f.values.get(answerKey(record.id, T1))!.text)).toEqual(data);
  const handling = take(await readFeedResponseHandling(f.output, { ...identity(card), responseId: response.responseId }));
  expect(handling.acknowledgement).toMatchObject({ responseId: response.responseId, phase: "acknowledged", handlingId: `${response.responseId}:acknowledged` });
  expect(handling.outcome).toBeNull();
});

test("running again for the same response writes nothing new", async () => {
  const { f, record, card } = await mirrored("ask");
  const response = await answer(f, card, { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 });
  await through(f, response);
  f.resetCalls();
  const again = await through(f, response);
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
  const result = await through(f, response);
  expect(result).toMatchObject({ wrote: "state", key, stored: "written", received: "recorded" });
  expect(JSON.parse(f.values.get(key)!.text)).toMatchObject({ kind: "task", id: record.id, doneAt, steps: { one: NOW }, notes: [{ id: "note00001", text: "Keep the old note" }] });
});

test("a different answer already stored under the same key is left as it is and nothing is acknowledged", async () => {
  const { f, record, card } = await mirrored("ask");
  take(await f.legacy.put(answerKey(record.id, T1), JSON.stringify({ askId: record.id, action: "drop", text: "", at: T1 }), { prefix: "", contentType: "application/json" }));
  const response = await answer(f, card, { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 });
  await expect(through(f, response)).rejects.toThrow("The board already holds a different answer for this response");
  expect(JSON.parse(f.values.get(answerKey(record.id, T1))!.text).action).toBe("drop");
  expect(await handled(f, card, response)).toBe(false);
});

test("a card action is not written through: no board write, no acknowledgement", async () => {
  const { f, card } = await mirrored("ask");
  const action = await message(f, card, { type: "feed.acknowledge", version: 1, data: {} });
  await expect(through(f, action)).rejects.toThrow("This response is not one the runner writes through");
  expect(kvWrites(f)).toBe(0);
  expect(await handled(f, card, action)).toBe(false);
});

/** A note as Home's typed-card composer sends it (SitrepCard `threadMessage`), with its owner-approved route. */
const NONCE = "0123456789abcdef0123456789abcdef";
const homeNote = (kind: Kind, id: string, text: string, extra: Record<string, unknown> = {}) => ({
  side: "sam", kind, id, at: T1, text, messageId: `${compactStamp(T1)}-${NONCE}`,
  delivery: { version: 1, targets: [{ recipientKey: "known-owner", agentId: "00000000-0000-4000-8000-000000000001", provider: "omp" }] }, ...extra,
});

test("a note typed on a feed card is written to the card thread where the sitrep UI writes Sam's messages, then Home is told it was received", async () => {
  for (const kind of ["ask", "task"] as const) {
    const { f, record, card } = await mirrored(kind);
    const response = await message(f, card, { type: "sitrep.thread", version: 1, data: homeNote(kind, record.id, "Which one is cheaper?") });
    const key = threadKey("sam", kind, record.id, T1, NONCE);
    expect(await through(f, response)).toEqual({ wrote: "thread", key, stored: "written", received: "recorded" });
    // Exactly the sitrep UI's stored shape (CardThread.tsx: SamThreadMessageSchema.parse({kind,id,at,text})): no route, side or id.
    const stored = JSON.parse(f.values.get(key)!.text);
    expect(stored).toEqual({ kind, id: record.id, at: T1, text: "Which one is cheaper?" });
    // What the officer relay (card-thread-watch) lists and parses: a Sam message under sam/thread/, keeping Home's message id.
    expect(key.startsWith(SAM_THREAD_PREFIX)).toBe(true);
    expect(parseThreadMessage(key, stored)).toEqual({ ...stored, side: "sam", messageId: `${compactStamp(T1)}-${NONCE}` });
    expect(take(await readFeedResponseHandling(f.output, { ...identity(card), responseId: response.responseId })).acknowledgement).toMatchObject({ phase: "acknowledged" });
    f.resetCalls();
    expect(await through(f, response)).toMatchObject({ stored: "already", received: "already" });
    expect(kvWrites(f)).toBe(0);
  }
});

test("an explicit resend from Home keeps the id of the message it resends", async () => {
  const { f, record, card } = await mirrored("ask");
  const original = `${compactStamp(T0)}-${"f".repeat(32)}`;
  const response = await message(f, card, { type: "sitrep.thread", version: 1, data: homeNote("ask", record.id, "Sending this again.", { resendOf: original }) });
  const { key } = await through(f, response);
  expect(JSON.parse(f.values.get(key)!.text)).toEqual({ kind: "ask", id: record.id, at: T1, text: "Sending this again.", resendOf: original });
});

test("a note the sitrep UI would refuse is not written through: a secret, over 1000 characters, another card's, or saved as an answer", async () => {
  const { f, record, card } = await mirrored("ask");
  const refused = [
    await message(f, card, { type: "sitrep.thread", version: 1, data: homeNote("ask", record.id, `The code is ${PRIVATE} ghp_${"a".repeat(36)}`) }),
    await message(f, card, { type: "sitrep.thread", version: 1, data: homeNote("ask", record.id, "x".repeat(1001)) }),
    await message(f, card, { type: "sitrep.thread", version: 1, data: homeNote("ask", "another-card", "Wrong card") }),
    await message(f, card, { type: "sitrep.thread", version: 1, data: { ...homeNote("ask", record.id, "Bad id"), messageId: `${compactStamp(T0)}-${NONCE}` } }),
    take(await appendFeedResponse(f.output, f.responses, { ...identity(card), responseId: randomUUID(), kind: "answer", choiceId: "yes", text: "A note", createdAt: T1 }, { type: "sitrep.thread", version: 1, data: homeNote("ask", record.id, "Saved as an answer") })),
  ];
  for (const response of refused) {
    await expect(through(f, response)).rejects.toThrow();
    expect(await handled(f, card, response)).toBe(false);
  }
  expect(kvWrites(f)).toBe(0);
});

test("a different message already stored under the note's key is left as it is and nothing is acknowledged", async () => {
  const { f, record, card } = await mirrored("ask");
  const key = threadKey("sam", "ask", record.id, T1, NONCE);
  take(await f.legacy.put(key, JSON.stringify({ kind: "ask", id: record.id, at: T1, text: "Something else" }), { prefix: "", contentType: "application/json" }));
  const response = await message(f, card, { type: "sitrep.thread", version: 1, data: homeNote("ask", record.id, "Which one is cheaper?") });
  await expect(through(f, response)).rejects.toThrow("The board already holds a different message for this response");
  expect(JSON.parse(f.values.get(key)!.text).text).toBe("Something else");
  expect(await handled(f, card, response)).toBe(false);
});

test("the log line for a note has ids and times only, never the note", async () => {
  const { f, record, card } = await mirrored("ask");
  const response = await message(f, card, { type: "sitrep.thread", version: 1, data: homeNote("ask", record.id, "A private thought about pricing") });
  const log = join(f.directory, "runner.log");
  const { value: code } = await quietly(() => runAnswerRunner(runnerArgs(log), async () => JSON.stringify(projectFeedResponseNotification(response)), session(f)));
  expect(code).toBe(0);
  const line = await readFile(log, "utf8");
  expect(line).not.toContain("private thought");
  expect(JSON.parse(line)).toMatchObject({ responseId: response.responseId, wrote: "thread", stored: "written", received: "recorded" });
});

test("the header on stdin grants nothing: a response the owner's database does not hold is refused", async () => {
  const { f, record, card } = await mirrored("ask");
  const response = await answer(f, card, { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 });
  const forged = { ...header(response), responseId: randomUUID() };
  await expect(writeThroughResponse(f.ctx, { sourceId: SOURCE, recipient: RUNNER, header: forged })).rejects.toThrow();
  const otherCard = { ...header(response), cardId: randomUUID() };
  await expect(writeThroughResponse(f.ctx, { sourceId: SOURCE, recipient: RUNNER, header: otherCard })).rejects.toThrow();
  expect(kvWrites(f)).toBe(0);
});

test("a restored answer this runner may not receive is neither written nor acknowledged: never dispatched, another recipient's, or past its deadline", async () => {
  const { f, record, card } = await mirrored("ask");
  const data = { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 };
  const refused = [
    await restored(f, card, data, () => []),
    await restored(f, card, data, (origin) => [policy(origin, { recipient: "another-runner" })]),
    await restored(f, card, data, (origin) => [policy(origin, { dispatchBefore: "2026-01-01T00:00:00.000Z" })]),
  ];
  // The SDK delivers none of them to this runner; the runner agrees, whatever the header says.
  expect(take(await listFeedResponseDeliveries(f.responses, { recipient: RUNNER, afterSequence: 0, limit: 100 })).responses).toEqual([]);
  f.resetCalls();
  for (const response of refused) {
    await expect(through(f, response)).rejects.toThrow("This response is not deliverable to this runner");
    expect(await handled(f, card, response)).toBe(false);
  }
  expect(kvWrites(f)).toBe(0);
  expect(f.values.has(answerKey(record.id, T1))).toBe(false);
});

test("a restored answer this runner may receive arrives with its dispatch deadline and is written through", async () => {
  const { f, record, card } = await mirrored("ask");
  const data = { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 };
  const response = await restored(f, card, data, (origin) => [policy(origin)]);
  const [delivery] = take(await listFeedResponseDeliveries(f.responses, { recipient: RUNNER, afterSequence: 0, limit: 100 })).responses;
  const notification = projectFeedResponseNotification(delivery!);
  expect(notification).toMatchObject({ responseId: response.responseId, dispatchBefore: null });
  const log = join(f.directory, "runner.log");
  const { value: code } = await quietly(() => runAnswerRunner(runnerArgs(log), async () => JSON.stringify(notification), session(f)));
  expect(code).toBe(0);
  expect(JSON.parse(f.values.get(answerKey(record.id, T1))!.text)).toEqual(data);
  expect(await handled(f, card, response)).toBe(true);
});

test("the runner logs the stored response's ids and times, never what the header on stdin claims", async () => {
  const { f, record, card } = await mirrored("ask");
  const response = await answer(f, card, { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 });
  const log = join(f.directory, "runner.log");
  const crafted = { ...header(response), createdAt: "SENTINEL-CREATED-AT", text: PRIVATE };
  const first = await quietly(() => runAnswerRunner(runnerArgs(log), async () => JSON.stringify(crafted), session(f)));
  expect(first.value).toBe(0);
  // A header that names no stored response: the line has no ids at all.
  const forged = { ...header(response), responseId: randomUUID(), cardId: randomUUID(), createdAt: "SENTINEL-CREATED-AT" };
  const second = await quietly(() => runAnswerRunner(runnerArgs(log), async () => JSON.stringify(forged), session(f)));
  expect(second.value).not.toBe(0);
  const text = await readFile(log, "utf8");
  expect(text).not.toContain("SENTINEL");
  expect(text).not.toContain(PRIVATE);
  const [ok, refused] = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(ok).toMatchObject({ responseId: response.responseId, cardId: card.cardId, createdAt: T1, wrote: "answer" });
  expect(Object.keys(refused!).sort()).toEqual(["at", "error", "pickupMs"]);
});

test("a board read or write that fails with the node's own message reaches the caller as a code, never the message", async () => {
  const BODY = "upstream body SYNTHETIC-HTTP-BODY-4410";
  const failed = { ok: false as const, error: { code: "NETWORK_ERROR", message: BODY, service: "kv", meta: { status: 500, body: BODY } } };
  for (const broken of ["get", "put"] as const) {
    const { f, record, card } = await mirrored("ask");
    const response = await answer(f, card, { askId: record.id, action: "answer", choice: "yes", text: "", at: T1 });
    const legacy = {
      get: broken === "get" ? async () => failed : f.legacy.get.bind(f.legacy),
      put: broken === "put" ? async () => failed : f.legacy.put.bind(f.legacy),
    } as unknown as HomeMirrorContext["legacy"];
    let error: unknown;
    try { await through(f, response, { ...f.ctx, legacy }); } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(inspect(error, { depth: 8 })).not.toContain("SYNTHETIC-HTTP-BODY");
    expect(error).toMatchObject({ diagnostic: { code: "NETWORK_ERROR", message: "Error details redacted", status: 500 } });
    expect(await handled(f, card, response)).toBe(false);
  }
});

test("an approval code is written to the board and kept out of the handoff ledger and the runner's log", async () => {
  const f = await mirrorNode(); cleanup.push(() => f.close());
  // An OpenKey approval that takes a code (JSON round trip: the fixture's go-approval kind is removed, not left undefined).
  const record = JSON.parse(JSON.stringify(boardRecord("approval", "runner-approval", { approvalType: "openkey", approvalKind: undefined, url: "https://openkey.so/delegate?request=synthetic", codeExpected: true }))) as BoardRecord;
  const card = { cardId: randomUUID(), revision: 1, issuanceId: randomUUID(), kind: "approval", title: record.title, body: record.body ?? "", urgency: 2, createdAt: T0, needsResponse: true,
    payload: { sitrep: { version: 1, record }, source: { label: "Synthetic", ref: boardKey("approval", record.id) } } } as FeedCard;
  await published(f, card, record);
  const value = { askId: record.id, action: "code", text: PRIVATE, at: T1, issuedAt: record.kind === "approval" ? record.issuedAt : T0 };
  // Home saves the header text as the action's safe summary, never the code.
  const text = safeSitrepActionSummary(validateSitrepAction(record, "sitrep.answer", value, T1));
  take(await appendFeedResponse(f.output, f.responses, { ...identity(card), responseId: randomUUID(), kind: "answer", text, createdAt: T1 }, { type: "sitrep.answer", version: 1, data: value }));
  const log = join(f.directory, "runner.log");
  const deliver = async (delivered: FeedResponse) => {
    const { value: code } = await quietly(() => runAnswerRunner(runnerArgs(log), async () => JSON.stringify(projectFeedResponseNotification(delivered)), session(f)));
    return code === 0 ? "delivered" as const : "unconfirmed" as const;
  };
  await drainHomeMirrorResponses(f.ctx, { source: f.source, recipient: RUNNER, handoff: f.ledger, deliver, afterSequence: 0 });
  expect(JSON.parse(f.values.get(answerKey(record.id, T1))!.text).text).toBe(PRIVATE);
  const rows = take(await f.ledger.query<string>("SELECT response_json,state FROM feed_handoffs")).rows;
  expect(rows.map((row) => [JSON.parse(row[0]!).text, row[1]])).toEqual([["Approval code saved privately", "delivered"]]);
  expect(JSON.stringify(rows)).not.toContain(PRIVATE);
  expect(await readFile(log, "utf8")).not.toContain(PRIVATE);
});

test("the log line has ids and times only, never what the owner wrote or a code", async () => {
  const { f, record, card } = await mirrored("ask");
  const response = await answer(f, card, { askId: record.id, action: "answer", text: PRIVATE, at: T1 });
  const result = await through(f, response);
  const start = "2026-11-13T09:00:07.500Z";
  const line = runnerLogLine(start, response, { result });
  expect(line).not.toContain(PRIVATE);
  expect(JSON.parse(line)).toEqual({ at: start, responseId: response.responseId, cardId: card.cardId, createdAt: T1, pickupMs: 7500, wrote: "answer", stored: "written", received: "recorded" });
  const failed = runnerLogLine(start, response, { code: "KV_PRECONDITION_FAILED" });
  expect(failed).not.toContain(PRIVATE);
  expect(JSON.parse(failed)).toMatchObject({ responseId: response.responseId, error: "KV_PRECONDITION_FAILED" });
  expect(inspect(f.values.get(answerKey(record.id, T1)))).toContain(PRIVATE); // the code reaches the board, as from sitrep
});

test("the runner exits non-zero without a source, a recipient, spaces or a response on stdin", async () => {
  const withoutRecipient = runnerArgs("/dev/null").filter((_, index, all) => all[index] !== "--recipient" && all[index - 1] !== "--recipient");
  const { errors } = await quietly(async () => {
    expect(await runAnswerRunner([], async () => "{}")).toBe(2);
    expect(await runAnswerRunner(withoutRecipient, async () => "{}")).toBe(2);
    expect(await runAnswerRunner(runnerArgs("/dev/null"), async () => JSON.stringify({ text: PRIVATE }))).toBe(2);
  });
  expect(errors.join("")).not.toContain(PRIVATE);
  for (const error of errors) expect(JSON.parse(error)).toMatchObject({ error: { code: "INVALID_INPUT", step: "arguments" }, delivery: "not-confirmed" });
});
