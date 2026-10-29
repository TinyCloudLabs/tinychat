import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyUpsert, askParts, currentAnswer, depGraph, expiryOf, foldsInto, goStale,
  openApprovals, prepareSitrepImport, recipients, steerState, unblockerDone,
  parseThreadMessage, recentThread, validatePreparedOwnerArchive,
  validateProgressTransition, validateRecord, validateState, waitingReport, projectSitrepCard, emptySitrepOwnerData, mergeSitrepStates, claimDecisionHistory, nextClaimDecisionAt, ownerDataFromPreparedBundle,
  type Answer, type Kind, type RecordOf,
} from "@tinyboilerplate/core/feed/sitrep";
import type { PrepareSitrepImportInput, PreparedSourceRow } from "@tinyboilerplate/core/feed/sitrep";
import { FROZEN_SITREP_RECORDS, FROZEN_SITREP_WATCH_CHECKPOINT, SITREP_CREATED, SITREP_NOW, SITREP_REASKED, syntheticRecord } from "./sitrep.fixtures";

function checked<K extends Kind>(kind: K, changes: Record<string, unknown> = {}): RecordOf<K> {
  const input = { ...syntheticRecord(kind), ...changes };
  for (const key of Object.keys(input)) if (input[key] === undefined) delete input[key];
  const parsed = validateRecord(kind, input);
  if (!parsed.ok || parsed.value.kind !== kind) throw new Error(`Invalid synthetic ${kind}`);
  // validateRecord and the explicit discriminator check establish this variant.
  return parsed.value as RecordOf<K>;
}
const answer = (at: string, text: string, extra: object = {}): Answer => ({ askId: "ask-synthetic", action: "answer", at, text, ...extra });
function sourceRow(sourceKey: string, value: unknown, sourceArea: PreparedSourceRow["sourceArea"] = "kv") {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return { sourceKey, sourceArea, encoding: "base64" as const, rawBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}
function importInput(): PrepareSitrepImportInput {
  const prefix = "xyz.tinycloud.rocinante/";
  return {
    source: { spaceId: "isolated-source-space", namespace: prefix, snapshotId: "synthetic-snapshot-1", completePrefixSnapshot: false, cursor: { opaque: "source-cursor" } },
    frozenAt: SITREP_NOW,
    rows: FROZEN_SITREP_RECORDS.map((record) => sourceRow(`${prefix}board/${record.kind}/${record.id}.json`, record)),
    publishers: [{ publisherId: "legacy-synthetic-publisher", agentId: "synthetic-agent-token", agentDid: "did:key:synthetic-publisher", outputResource: "xyz.tinycloud.tinychat/feed/feed_output_synthetic", responseResource: "xyz.tinycloud.tinychat/feed/feed_responses_synthetic" }],
    publisherBindings: FROZEN_SITREP_RECORDS.map((record) => ({ sourceKey: `${prefix}board/${record.kind}/${record.id}.json`, publisherId: "legacy-synthetic-publisher", identity: { cardId: `synthetic-${record.kind}-${record.id}`, revision: 1, issuanceId: `synthetic-${record.kind}-issuance-1` } })),
    recipients: [
      { recipientKey: "synthetic-officer-key", legacyName: "SyntheticOfficer", runtimeTarget: { agentId: "00000000-0000-4000-8000-000000000002", provider: "omp" } },
      { recipientKey: "synthetic-owner-key", legacyName: "SyntheticOwner" },
      { recipientKey: "synthetic-xo-key", legacyName: "xo" },
    ],
  };
}

test.each(FROZEN_SITREP_RECORDS.map((record) => [record.kind, record.id] as const))("preserves the typed %s record and rejects its conflicting discriminator", (kind, id) => {
  const record = syntheticRecord(kind);
  expect(validateRecord(kind as Kind, record)).toMatchObject({ ok: true, value: { kind, id } });
  expect(validateRecord(kind as Kind, { ...record, kind: "not-this-kind" }).ok).toBe(false);
});

test("reasks use original answer times, not import order or response sequence", () => {
  const ask = checked("ask", { lastAskedAt: SITREP_REASKED });
  const current = { ...answer("2026-10-29T11:00:00.000Z", "Current owner decision"), sequence: 1 };
  const stale = { ...answer("2026-10-29T09:00:00.000Z", "Stale imported last"), sequence: 999 };
  expect(currentAnswer(ask, [current, stale])?.text).toBe("Current owner decision");
  expect(currentAnswer(ask, [stale])).toBeUndefined();
  expect(waitingReport({ records: [ask], answers: [stale], states: [] }, Date.parse(SITREP_NOW)).waiting.map((item) => item.record.id)).toEqual([ask.id]);
});

test("recommendation differs from proceeding default and the exact decideBy boundary is preserved", () => {
  const ask = checked("ask", { mode: "proceeding", recommend: "careful", default: "quick", decideBy: SITREP_NOW });
  expect(ask.recommend).toBe("careful");
  expect(ask.default).toBe("quick");
  expect(steerState(ask, Date.parse(SITREP_NOW) - 1)).toBe("open");
  expect(steerState(ask, Date.parse(SITREP_NOW))).toBe("closed-proceeding");
  expect(steerState({ ...ask, proceededAt: SITREP_NOW }, Date.parse(SITREP_NOW))).toBe("done");
});

test("stale issuance and a go delivered at its expiry cannot authorize an action", () => {
  const approval = checked("approval", { expiresAt: SITREP_NOW });
  const response: Answer = { askId: approval.id, action: "done", text: "", at: "2026-10-29T11:00:00.000Z", issuedAt: approval.issuedAt };
  expect(goStale(response, approval, "2026-10-29T11:59:59.999Z")).toBeNull();
  expect(goStale(response, approval, SITREP_NOW)).not.toBeNull();
  expect(goStale({ ...response, issuedAt: SITREP_CREATED }, approval, response.at)).not.toBeNull();
  expect(openApprovals([approval], [{ ...response, issuedAt: SITREP_CREATED }], Date.parse(SITREP_NOW))[0]?.answer).toBeUndefined();
});

test("folded secret parts respect poster consent, skipOn, and a later reask", () => {
  const ask = checked("ask");
  const part = checked("approval", { id: "secret-part", approvalType: "secret", approvalKind: undefined, name: "SYNTHETIC_KEY", url: "https://secrets.tinycloud.xyz/request?fixture=synthetic", forAsk: { id: ask.id, skipOn: ["quick"] } });
  expect(foldsInto(part, ask)).toBe(true);
  expect(foldsInto({ ...part, from: "UnrelatedOfficer" }, ask)).toBe(false);
  const reply = answer("2026-10-29T09:00:00.000Z", "", { choice: "quick" });
  expect(askParts([ask, part], [reply], Date.parse(SITREP_NOW)).byAsk.get(ask.id)?.[0]?.notNeeded).toBeDefined();
  const reasked = { ...ask, lastAskedAt: SITREP_REASKED };
  expect(askParts([reasked, part], [reply], Date.parse(SITREP_NOW)).byAsk.get(ask.id)?.[0]?.notNeeded).toBeUndefined();
});

test("task ticks finish only that task and snooze history continues to postpone expiry", () => {
  const task = checked("task");
  const state = validateState({ kind: "task", id: task.id, steps: { verify: SITREP_REASKED, undo: null }, updatedAt: SITREP_REASKED, snoozedUntil: null, snoozes: [{ at: SITREP_CREATED, until: SITREP_NOW }] });
  if (!state.ok) throw new Error("Invalid synthetic task state");
  expect(expiryOf(task, state.value)).toBeGreaterThanOrEqual(Date.parse(SITREP_NOW) + 24 * 3_600_000);
  expect(waitingReport({ records: [task], answers: [], states: [state.value] }, Date.parse(SITREP_NOW)).waiting.map((item) => item.record.id)).toEqual([task.id]);
  const complete = { ...state.value, steps: { verify: SITREP_REASKED, undo: SITREP_NOW } };
  expect(expiryOf(task, complete)).toBeNull();
  expect(waitingReport({ records: [task], answers: [], states: [complete] }, Date.parse(SITREP_NOW)).waiting).toEqual([]);
});

test("hold clearing preserves all versus any and never treats external refs as verified completion", () => {
  const task = checked("task", { status: "done" });
  const ask = checked("ask");
  const hold = checked("hold", { unblockedBy: [`task:${task.id}`, `ask:${ask.id}`] });
  expect(unblockerDone(depGraph([task, ask, hold]), hold)).toBe(false);
  const any = { ...hold, unblockedByMode: "any" as const };
  expect(unblockerDone(depGraph([task, ask, any]), any)).toBe(true);
  const cleared = { ...hold, clearedRefs: [{ ref: `ask:${ask.id}`, by: "sam" as const, at: SITREP_NOW }] };
  expect(unblockerDone(depGraph([task, ask, cleared]), cleared)).toBe(true);
  const external = { ...hold, unblockedBy: ["TC-1"] };
  expect(unblockerDone(depGraph([external]), external)).toBe(false);
});

test("ship/order history is not editable and progress updaters cannot become owners or reopen closed work", () => {
  for (const kind of ["ship", "order"] as const) {
    const record = checked(kind);
    expect(applyUpsert(kind, record.id, record, { title: "Rewrite history" }, { now: SITREP_NOW, from: record.from }).ok).toBe(false);
  }
  const progress = checked("progress");
  expect(validateProgressTransition(progress, { owner: "OtherOwner" }, { operation: "set", actorName: progress.owner, verifiedLive: true }).ok).toBe(false);
  expect(validateProgressTransition({ ...progress, status: "closed", closedAt: SITREP_NOW }, { note: "Reopen indirectly" }, { operation: "note", actorName: progress.owner, verifiedLive: true }).ok).toBe(false);
  expect(validateProgressTransition(progress, { note: "Allowed appointed update" }, { operation: "note", actorName: progress.owner, agentId: progress.updaters?.[0], verifiedLive: false }).ok).toBe(false);
});

test("logical co-owners remain separate recipients and are never authenticated publishers", () => {
  const hold = checked("hold", { owner: "SynOwner / SynOfficer / sam / SynOwner" });
  expect(recipients(hold)).toEqual(["SynOwner", "SynOfficer"]);
});

test("unknown bytes stay in owner quarantine and partial snapshots never imply deletion", async () => {
  const input = importInput();
  const unknown = sourceRow("xyz.tinycloud.rocinante/future/opaque.json", { kind: "future-kind", untouched: "α\nβ" });
  input.rows.push(unknown);
  const first = await prepareSitrepImport(input);
  expect(first.quarantine).toContainEqual(expect.objectContaining({ sourceKey: unknown.sourceKey, reason: "unknown" }));
  expect(first.sourceRows.find((row) => row.sourceKey === unknown.sourceKey)).toMatchObject({ rawBase64: unknown.rawBase64, sha256: unknown.sha256, classification: "quarantine" });
  const second = await prepareSitrepImport({ ...input, source: { ...input.source, snapshotId: "synthetic-snapshot-2" }, rows: input.rows.filter((row) => row.sourceKey !== unknown.sourceKey), previous: first });
  expect(second.deletions).toEqual([]);
});

test("historical per-recipient sent/unconfirmed state and expiry checkpoints survive re-preparation without dispatch", async () => {
  const input = importInput();
  const answerKey = "xyz.tinycloud.rocinante/sam/answers/ask-synthetic/20261029T110000000Z.json";
  input.rows.push(sourceRow(answerKey, answer("2026-10-29T11:00:00.000Z", "Historical owner answer")));
  const watch = structuredClone(FROZEN_SITREP_WATCH_CHECKPOINT);
  watch.delivered[answerKey] = { done: ["SyntheticOfficer"], complete: false };
  input.rows.push(sourceRow("watch.json", watch, "watch-state"));
  input.rows.push(sourceRow("watch.expiry.json", { version: 1, since: SITREP_CREATED, firstRun: { SyntheticOfficer: ["ask/ask-synthetic"] }, owed: { "ask/ask-synthetic@2026-10-29T09:00:00.000Z": "SyntheticOfficer" } }, "expiry-state"));
  const first = await prepareSitrepImport(input);
  const sent = first.deliveries.find((delivery) => delivery.eventSourceKey === answerKey && delivery.recipientKey === "synthetic-officer-key");
  expect(sent).toMatchObject({ state: "unconfirmed", dispatch: "never", evidence: "sent-without-confirmation" });
  expect(first.checkpoints).toContainEqual(expect.objectContaining({ type: "expiry-grace", value: expect.objectContaining({ since: SITREP_CREATED }) }));
  const second = await prepareSitrepImport({ ...input, previous: first });
  expect(second.ownerResponses.map((response) => response.response.responseId)).toEqual(first.ownerResponses.map((response) => response.response.responseId));
  expect(second.deliveries.find((delivery) => delivery.eventSourceKey === answerKey && delivery.recipientKey === "synthetic-officer-key")?.dispatch).toBe("never");
  expect(second.deliveries.find((delivery) => delivery.eventSourceKey === answerKey && delivery.recipientKey === "synthetic-xo-key")).toMatchObject({ state: "held", dispatch: "held" });
});

test("explicit deletion survives preparation, while source-scope or digest substitution is refused", async () => {
  const input = importInput();
  const first = await prepareSitrepImport(input);
  const removed = input.rows.find((row) => row.sourceKey.endsWith("/order/order-synthetic.json"))!;
  const deletion = { sourceKey: removed.sourceKey, classification: "card" as const, previousSha256: removed.sha256, deletedAt: SITREP_NOW };
  const second = await prepareSitrepImport({ ...input, source: { ...input.source, snapshotId: "synthetic-snapshot-2" }, rows: input.rows.filter((row) => row.sourceKey !== removed.sourceKey), previous: first, deletions: [deletion] });
  expect(second.deletions).toContainEqual(deletion);
  expect(second.cards.some((card) => card.sourceKey === removed.sourceKey)).toBe(false);
  await expect(prepareSitrepImport({ ...input, source: { ...input.source, spaceId: "different-source-space" }, previous: first })).rejects.toThrow();
  await expect(prepareSitrepImport({ ...input, rows: [{ ...input.rows[0]!, rawBase64: Buffer.from("changed bytes").toString("base64") }, ...input.rows.slice(1)] })).rejects.toThrow();
});

test("thread keys bind reply/resend IDs and immutable message times without changing the card answer", () => {
  const originalId = "20261029T110000000Z-00000000000000000000000000000001";
  const resendId = "20261029T110100000Z-00000000000000000000000000000002";
  const originalKey = `xyz.tinycloud.rocinante/sam/thread/ask/ask-synthetic/${originalId}.json`;
  const resendKey = `xyz.tinycloud.rocinante/sam/thread/ask/ask-synthetic/${resendId}.json`;
  const original = parseThreadMessage(originalKey, { kind: "ask", id: "ask-synthetic", text: "Immutable synthetic message", at: "2026-10-29T11:00:00.000Z" });
  const resend = parseThreadMessage(resendKey, { kind: "ask", id: "ask-synthetic", text: "Immutable synthetic message", at: "2026-10-29T11:01:00.000Z", resendOf: originalId });
  if (!original || !resend) throw new Error("Invalid synthetic thread fixture");
  expect(recentThread([resend, original]).map((message) => message.messageId)).toEqual([originalId, resendId]);
  expect(resend).toMatchObject({ resendOf: originalId, messageId: resendId });
  expect(parseThreadMessage(resendKey, { kind: "ask", id: "ask-synthetic", text: "Wrong timestamp", at: SITREP_CREATED, resendOf: originalId })).toBeNull();
  expect(currentAnswer(checked("ask"), [])).toBeUndefined();
});

test("partial task checks and snoozes remain owner-only rather than command envelopes", async () => {
  const input = importInput();
  input.rows.push(sourceRow("xyz.tinycloud.rocinante/sam/state/task/task-synthetic.json", {
    kind: "task", id: "task-synthetic", steps: { verify: SITREP_NOW },
    snoozedUntil: "2026-10-30T08:00:00.000Z", snoozes: [{ at: SITREP_NOW, until: "2026-10-30T08:00:00.000Z" }],
    updatedAt: SITREP_NOW,
  }));
  const prepared = await prepareSitrepImport(input);
  expect(prepared.ownerState).toContainEqual(expect.objectContaining({ type: "state", value: expect.objectContaining({ steps: { verify: SITREP_NOW } }) }));
  expect(prepared.ownerResponses).toEqual([]);
});

test("a historical task closure discloses only its intended command, never private state", async () => {
  const input = importInput();
  input.rows.push(sourceRow("xyz.tinycloud.rocinante/sam/state/task/task-synthetic.json", {
    kind: "task", id: "task-synthetic", steps: { verify: SITREP_NOW },
    doneAt: SITREP_NOW, dismissedAt: SITREP_NOW, updatedAt: SITREP_NOW,
  }));
  const prepared = await prepareSitrepImport(input);
  expect(prepared.ownerResponses).toHaveLength(1);
  expect(prepared.ownerResponses[0]).toMatchObject({ ownerEventKind: "state", payload: { type: "sitrep.state", data: { kind: "task", id: "task-synthetic", doneAt: SITREP_NOW, steps: {} } } });
  expect(prepared.ownerResponses[0]?.legacyAnswer).toBeUndefined();
  expect(prepared.ownerResponses[0]?.payload?.data).not.toHaveProperty("dismissedAt");
});

test("hold-action mid-send history remains unconfirmed and non-dispatchable on replay", async () => {
  const input = importInput();
  const requestId = "clearrequest00001";
  const requestKey = `clear:hold-synthetic|task:task-synthetic|${requestId}`;
  input.rows.push(sourceRow("xyz.tinycloud.rocinante/sam/state/hold/hold-synthetic.json", {
    kind: "hold", id: "hold-synthetic", clears: [{ id: requestId, ref: "task:task-synthetic", at: SITREP_NOW }], updatedAt: SITREP_NOW,
  }));
  input.rows.push(sourceRow("watch.holdactions.json", {
    version: 1, acted: { [requestKey]: { at: SITREP_NOW, outcome: "applied" } },
    owed: { [`notice:${requestKey}@SyntheticOwner`]: { to: "SyntheticOwner", line: "Original opaque notice", at: SITREP_NOW, sending: SITREP_NOW } },
  }, "watch-state"));
  const first = await prepareSitrepImport(input);
  expect(first.checkpoints).toContainEqual(expect.objectContaining({ type: "hold-actions", value: expect.objectContaining({ acted: expect.any(Object) }) }));
  expect(first.deliveries.find((delivery) => delivery.eventKey === requestKey)).toMatchObject({ state: "unconfirmed", dispatch: "never" });
  const replay = await prepareSitrepImport({ ...input, previous: first });
  expect(replay.deliveries.find((delivery) => delivery.eventKey === requestKey)).toMatchObject({ state: "unconfirmed", dispatch: "never" });
  expect(replay.ownerResponses[0]?.response.responseId).toBe(first.ownerResponses[0]?.response.responseId);
});

test("the prepared canonical card is complete data, including identity and the exact typed wrapper", async () => {
  const prepared = await prepareSitrepImport(importInput());
  const ask = prepared.cards.find((card) => card.record.kind === "ask")!;
  expect(ask.canonicalCard).toMatchObject({ ...ask.identity, kind: "ask", payload: { sitrep: { version: 1, record: { kind: "ask", id: "ask-synthetic" } } } });
  expect(JSON.stringify(ask.canonicalCard)).not.toContain("legacyAnswer");
});

function pendingApprovalInput(changes: Record<string, unknown>, action: "done" | "code" = "done") {
  const input = importInput();
  const record = { ...syntheticRecord("approval"), ...changes };
  const cardKey = "xyz.tinycloud.rocinante/board/approval/approval-synthetic.json";
  input.rows = input.rows.map((row) => row.sourceKey === cardKey ? sourceRow(cardKey, record) : row);
  const key = "xyz.tinycloud.rocinante/sam/answers/approval-synthetic/20261029T110000000Z.json";
  input.rows.push(sourceRow(key, { askId: "approval-synthetic", action, issuedAt: record.issuedAt, text: action === "code" ? "SYNTHETIC-CODE" : "", at: "2026-10-29T11:00:00.000Z" }));
  input.rows.push(sourceRow("watch.json", { version: 2, cursor: SITREP_CREATED, delivered: {}, tasks: {} }, "watch-state"));
  return { input, key };
}

test("pending go delivery carries its actual execution end and expiry never grants pending authority", async () => {
  const { input, key } = pendingApprovalInput({ expiresAt: "2026-10-29T13:00:00.000Z" });
  const prepared = await prepareSitrepImport(input);
  expect(prepared.deliveries.find((delivery) => delivery.eventSourceKey === key && delivery.recipientKey === "synthetic-officer-key")).toMatchObject({ state: "pending", dispatch: "resolved-pending", dispatchBefore: "2026-10-29T13:00:00.000Z" });
  const expired = await prepareSitrepImport({ ...input, frozenAt: "2026-10-29T14:00:00.000Z" });
  expect(expired.deliveries.filter((delivery) => delivery.eventSourceKey === key).every((delivery) => delivery.dispatch !== "resolved-pending")).toBe(true);
  expect(expired.deliveries.find((delivery) => delivery.eventSourceKey === key && delivery.recipientKey === "synthetic-officer-key")?.state).toBe("refused");
});

test("a non-go code does not borrow a consent-page expiry as an invented execution cutoff", async () => {
  const { input, key } = pendingApprovalInput({ approvalType: "openkey", approvalKind: undefined, url: "https://openkey.so/delegate?fixture=synthetic", codeExpected: true, expiresAt: "2026-10-29T11:30:00.000Z" }, "code");
  const prepared = await prepareSitrepImport(input);
  expect(prepared.deliveries.find((delivery) => delivery.eventSourceKey === key && delivery.recipientKey === "synthetic-officer-key")).toMatchObject({ state: "pending", dispatch: "resolved-pending", dispatchBefore: null });
  expect(prepared.deliveries.some((delivery) => delivery.eventSourceKey === key && delivery.recipientKey === "synthetic-xo-key")).toBe(false);
});

test("a mapped recipient does not turn an explicitly held legacy thread into pending authority", async () => {
  const input = importInput();
  const messageId = "20261029T110000000Z-00000000000000000000000000000001";
  const key = `xyz.tinycloud.rocinante/sam/thread/ask/ask-synthetic/${messageId}.json`;
  input.rows.push(sourceRow(key, { kind: "ask", id: "ask-synthetic", at: "2026-10-29T11:00:00.000Z", text: "Still held, not newly authorized." }));
  input.rows.push(sourceRow("watch.thread.json", { attempts: { [key]: { state: "waiting", recipient: "SyntheticOfficer", routedTo: "owner", at: SITREP_NOW, reason: "busy" } } }, "thread-watch-state"));
  const prepared = await prepareSitrepImport(input);
  expect(prepared.deliveries.find((delivery) => delivery.eventSourceKey === key)).toMatchObject({ state: "held", dispatch: "held" });
  expect(prepared.ownerResponses.find((response) => response.sourceKey === key)?.response.kind).toBe("message");
});

test("preparing a later partial snapshot never mutates the previously frozen archive", async () => {
  const input = importInput();
  const first = await prepareSitrepImport({ ...input, publishers: [] });
  const frozen = JSON.stringify(first);
  await prepareSitrepImport({ ...input, source: { ...input.source, snapshotId: "late-explicit-publisher-binding" }, rows: [], previous: first });
  expect(JSON.stringify(first)).toBe(frozen);
});

test("archive admission rejects mismatched canonical identity and message decision fields", async () => {
  const prepared = await prepareSitrepImport(importInput());
  const wrong = structuredClone(prepared);
  Object.assign(wrong.cards[0]!.canonicalCard, { issuanceId: "not-the-declared-issuance" });
  await expect(validatePreparedOwnerArchive(wrong)).rejects.toThrow();
  const { input } = pendingApprovalInput({ expiresAt: "2026-10-29T13:00:00.000Z" });
  const messages = await prepareSitrepImport(input);
  const header = messages.ownerResponses[0]!.response;
  Object.assign(header, { kind: "message", choiceId: "must-not-be-a-message-choice" });
  await expect(validatePreparedOwnerArchive(messages)).rejects.toThrow();
});

test("an old or contradictory pending policy cannot acquire authority by omitting its execution deadline", async () => {
  const { input } = pendingApprovalInput({ expiresAt: "2026-10-29T13:00:00.000Z" });
  const prepared = await prepareSitrepImport(input);
  const missing = structuredClone(prepared);
  const policy = missing.deliveries.find((delivery) => delivery.dispatch === "resolved-pending")!;
  const rawPolicy = policy as unknown as Record<string, unknown>;
  delete rawPolicy.dispatchBefore;
  await expect(validatePreparedOwnerArchive(missing)).rejects.toThrow();
  const contradictory = structuredClone(prepared);
  const allowed = contradictory.deliveries.find((delivery) => delivery.dispatch === "resolved-pending")!;
  contradictory.deliveries.push({ ...allowed, state: "unconfirmed", dispatch: "never" });
  await expect(validatePreparedOwnerArchive(contradictory)).rejects.toThrow();
});

test("legacy explicit send-notes preserve distinct watcher identities and raw-state provenance", async () => {
  const input = importInput();
  Object.assign(input.recipients.find((recipient) => recipient.recipientKey === "synthetic-owner-key")!, { runtimeTarget: { agentId: "00000000-0000-4000-8000-000000000003", provider: "omp" } });
  const key = "xyz.tinycloud.rocinante/sam/state/task/task-synthetic.json";
  input.rows.push(sourceRow(key, { kind: "task", id: "task-synthetic", steps: {}, notes: [
    { id: "note000000000001", at: SITREP_NOW, text: "First explicit legacy note" },
    { id: "note000000000002", at: SITREP_NOW, text: "Second explicit legacy note" },
  ], updatedAt: SITREP_NOW }));
  input.rows.push(sourceRow("watch.json", structuredClone(FROZEN_SITREP_WATCH_CHECKPOINT), "watch-state"));
  const prepared = await prepareSitrepImport(input);
  const messages = prepared.ownerResponses.filter((row) => row.ownerEventKind === "note");
  expect(messages.map((row) => row.eventKey)).toEqual(["note:task/task-synthetic/note000000000001", "note:task/task-synthetic/note000000000002"]);
  expect(new Set(messages.map((row) => row.response.responseId)).size).toBe(2);
  expect(messages.every((row) => row.sourceKey === key && row.response.kind === "message" && row.restoreTarget === "agent-response")).toBe(true);
  expect(messages[0]?.payload).toMatchObject({ type: "sitrep.note", data: { text: "First explicit legacy note" } });
  expect(JSON.stringify(messages.map((row) => row.response))).not.toContain("First explicit legacy note");
  expect(prepared.deliveries.some((row) => row.eventKey === messages[0]!.eventKey && row.state === "pending" && row.dispatch === "resolved-pending")).toBe(true);
});

test("unresolved legacy send-note recipients stay owner-only and sent notes never replay", async () => {
  const input = importInput();
  const key = "xyz.tinycloud.rocinante/sam/state/task/task-synthetic.json";
  const eventKey = "note:task/task-synthetic/note000000000003";
  input.rows.push(sourceRow(key, { kind: "task", id: "task-synthetic", steps: {}, notes: [{ id: "note000000000003", at: SITREP_NOW, text: "Explicit intended note" }], updatedAt: SITREP_NOW }));
  const watch = structuredClone(FROZEN_SITREP_WATCH_CHECKPOINT);
  watch.delivered[eventKey] = { done: ["SyntheticOwner"], complete: false };
  input.rows.push(sourceRow("watch.json", watch, "watch-state"));
  const sent = await prepareSitrepImport(input);
  expect(sent.deliveries.find((row) => row.eventKey === eventKey && row.recipientKey === "synthetic-owner-key")).toMatchObject({ state: "unconfirmed", dispatch: "never" });
  const unresolved = await prepareSitrepImport({ ...input, recipients: input.recipients.map((recipient) => ({ ...recipient, runtimeTarget: undefined })) });
  expect(unresolved.ownerResponses.find((row) => row.eventKey === eventKey)?.restoreTarget).toBe("owner-only");
  expect(unresolved.deliveries.every((row) => row.dispatch !== "resolved-pending")).toBe(true);
});

test("an incomplete successor cannot resurrect archived bytes of a deleted card or owner state", async () => {
  const input = importInput();
  const stateKey = "xyz.tinycloud.rocinante/sam/state/task/task-synthetic.json";
  input.rows.push(sourceRow(stateKey, { kind: "task", id: "task-synthetic", steps: { verify: SITREP_NOW }, updatedAt: SITREP_NOW }));
  const first = await prepareSitrepImport(input);
  const deletedKey = "xyz.tinycloud.rocinante/board/ask/ask-synthetic.json";
  const second = await prepareSitrepImport({ ...input, source: { ...input.source, snapshotId: "snapshot-after-delete" }, rows: [], previous: first, deletions: [deletedKey, stateKey].map((sourceKey) => ({ sourceKey, classification: first.sourceRows.find((row) => row.sourceKey === sourceKey)!.classification, deletedAt: SITREP_NOW })) });
  const third = await prepareSitrepImport({ ...input, source: { ...input.source, snapshotId: "snapshot-incomplete-successor" }, rows: [], previous: second });
  expect(third.source.previousSnapshotId).toBe(second.source.snapshotId);
  expect(third.cards.some((card) => card.sourceKey === deletedKey)).toBe(false);
  expect(third.ownerState.some((state) => state.sourceKey === stateKey)).toBe(false);
  expect(third.deletions.map((deletion) => deletion.sourceKey).sort()).toEqual([deletedKey, stateKey].sort());
  expect(third.sourceRows.find((row) => row.sourceKey === deletedKey)?.rawBase64).toBe(first.sourceRows.find((row) => row.sourceKey === deletedKey)?.rawBase64);
  const recreated = await prepareSitrepImport({ ...input, source: { ...input.source, snapshotId: "explicit-recreation" }, rows: [sourceRow(stateKey, { kind: "task", id: "task-synthetic", steps: {}, updatedAt: SITREP_NOW })], previous: third });
  expect(recreated.ownerState.some((state) => state.sourceKey === stateKey)).toBe(true);
  expect(recreated.cards.some((card) => card.sourceKey === deletedKey)).toBe(false);
});

test("a todo task without checklist steps still requires its actual completion decision", () => {
  const task = checked("task", { steps: [] });
  const owner = emptySitrepOwnerData();
  expect(projectSitrepCard(task, [task], owner, Date.parse(SITREP_NOW)).needsAction).toBe(true);
  expect(waitingReport({ records: [task], answers: [], states: [] }, Date.parse(SITREP_NOW)).waiting.some((item) => item.record.id === task.id)).toBe(true);
});

test("private owner-log commit order can apply an untick without rewriting its original clock", () => {
  const laterClock = validateState({ kind: "task", id: "task-synthetic", steps: { verify: SITREP_NOW }, updatedAt: SITREP_NOW });
  const finalCommit = validateState({ kind: "task", id: "task-synthetic", steps: { verify: null }, updatedAt: SITREP_CREATED });
  if (!laterClock.ok || !finalCommit.ok) throw new Error("Invalid synthetic private deltas");
  const state = mergeSitrepStates([laterClock.value, finalCommit.value], "provided")[0]!;
  expect(state.steps.verify).toBeNull();
  expect(state.updatedAt).toBe(SITREP_CREATED);
});

test("progress note and step admission cannot rewrite ownership, appointments, step names or unrelated fields", () => {
  const prior = checked("progress");
  const actor = { operation: "note" as const, actorName: prior.owner, verifiedLive: true };
  expect(validateProgressTransition(prior, { updaters: ["00000000-0000-4000-8000-000000000099"] }, actor).ok).toBe(false);
  expect(validateProgressTransition(prior, { title: "Rewrite from note" }, actor).ok).toBe(false);
  expect(validateProgressTransition(prior, { steps: prior.steps.map((step, index) => index ? step : { ...step, name: "Renamed step" }) }, { ...actor, operation: "step" }).ok).toBe(false);
  expect(validateProgressTransition(prior, { note: "A real appointed note", updatedAt: SITREP_NOW }, actor)).toMatchObject({ ok: true, value: { note: "A real appointed note" } });
});

test("claim history compares original instants and full source keys, never transport order", () => {
  const owner = emptySitrepOwnerData();
  owner.claimDecisions = [
    { sourceKey: "claim/z", card: { kind: "claim", id: "T-001" }, value: { choice: "remove", at: "2026-10-29T12:00:00+02:00" } },
    { sourceKey: "claim/b", card: { kind: "claim", id: "T-001" }, value: { choice: "ignore", at: "2026-10-29T11:00:00Z" } },
    { sourceKey: "claim/a", card: { kind: "claim", id: "T-001" }, value: { choice: "keep", at: "2026-10-29T11:00:00Z" } },
  ];
  expect(claimDecisionHistory(owner, "T-001").map((row) => row.value.choice)).toEqual(["remove", "keep", "ignore"]);
  expect(nextClaimDecisionAt(owner, "T-001", Date.parse(SITREP_CREATED))).toBe("2026-10-29T11:00:00.001Z");
});

test("one unresolved co-owner cannot authorize itself or hold an independently mapped legacy note recipient", async () => {
  const input = importInput();
  const key = "xyz.tinycloud.rocinante/board/task/task-synthetic.json";
  input.rows = input.rows.filter((row) => row.sourceKey !== key);
  input.rows.push(sourceRow(key, { ...syntheticRecord("task"), owner: "SyntheticOwner / SyntheticOfficer" }));
  input.rows.push(sourceRow("xyz.tinycloud.rocinante/sam/state/task/task-synthetic.json", { kind: "task", id: "task-synthetic", steps: {}, notes: [{ id: "note000000000004", at: SITREP_NOW, text: "Explicit note for both owners" }], updatedAt: SITREP_NOW }));
  input.rows.push(sourceRow("watch.json", structuredClone(FROZEN_SITREP_WATCH_CHECKPOINT), "watch-state"));
  const prepared = await prepareSitrepImport(input);
  expect(prepared.deliveries.find((row) => row.recipientKey === "synthetic-owner-key")).toMatchObject({ state: "held", dispatch: "held" });
  expect(prepared.deliveries.find((row) => row.recipientKey === "synthetic-officer-key")).toMatchObject({ state: "pending", dispatch: "resolved-pending" });
});

test("archive projections must match actual frozen source bytes, not only a mutually consistent invented wrapper", async () => {
  const prepared = await prepareSitrepImport(importInput());
  const card = prepared.cards[0]!;
  card.record.title = "A different unsourced title";
  card.canonicalCard.title = card.record.title;
  card.canonicalCard.payload.sitrep.record.title = card.record.title;
  await expect(validatePreparedOwnerArchive(prepared)).rejects.toThrow();
});

test("a null go cutoff or approval code copied into the safe header is rejected", async () => {
  const go = await prepareSitrepImport(pendingApprovalInput({ expiresAt: "2026-10-29T13:00:00.000Z" }).input);
  go.deliveries.find((row) => row.dispatch === "resolved-pending")!.dispatchBefore = null;
  await expect(validatePreparedOwnerArchive(go)).rejects.toThrow();
  const code = await prepareSitrepImport(pendingApprovalInput({ approvalType: "openkey", approvalKind: undefined, url: "https://openkey.so/delegate?fixture=synthetic", codeExpected: true }, "code").input);
  code.ownerResponses[0]!.response.text = String(code.ownerResponses[0]!.legacyAnswer!.text);
  await expect(validatePreparedOwnerArchive(code)).rejects.toThrow();
});

test("an unresolved historical approval issuance remains owner history without manufacturing an agent response", async () => {
  const input = importInput();
  const oldCode = "ISOLATED-HISTORICAL-PRIVATE-CODE-ONLY";
  input.rows.push(sourceRow("xyz.tinycloud.rocinante/sam/answers/approval-synthetic/20261029T090000000Z.json", { askId: "approval-synthetic", action: "code", text: oldCode, issuedAt: SITREP_CREATED, at: "2026-10-29T09:00:00.000Z" }));
  const prepared = await prepareSitrepImport(input);
  expect(prepared.ownerResponses).toEqual([]);
  const owner = ownerDataFromPreparedBundle(prepared);
  expect(owner.answers).toContainEqual(expect.objectContaining({ card: { kind: "approval", id: "approval-synthetic" }, value: expect.objectContaining({ text: oldCode, issuedAt: SITREP_CREATED }) }));
  expect(JSON.stringify(prepared.cards)).not.toContain(oldCode);
  const approval = prepared.cards.find((card) => card.record.kind === "approval")!;
  expect(projectSitrepCard(approval.record, prepared.cards.map((card) => card.record), owner, Date.parse(SITREP_NOW)).needsAction).toBe(true);
});
