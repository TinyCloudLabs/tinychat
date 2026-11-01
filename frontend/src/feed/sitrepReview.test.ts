import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import {
  answerKey, claimDecisionKey, currentAnswer, emptySitrepOwnerData,
  mergeSitrepStates, openApprovals, ownerDataFromPreparedBundle,
  prepareSitrepImport, projectSitrepCard, threadKey,
  validatePreparedOwnerArchive, validateRecord, validateState,
  type Answer, type Approval, type Ask, type PrepareSitrepImportInput,
  type PreparedSitrepImportBundle, type SamState,
} from "@tinyboilerplate/core/feed/sitrep";
import { FROZEN_SITREP_RECORDS, SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";

const PREFIX = "xyz.tinycloud.rocinante/";
const AT = "2026-10-29T11:00:00.000Z";
const NONCE = "00000000000000000000000000000001";
const PRIVATE_MARKER = "SYNTHETIC-OWNER-ONLY-REVIEW-MARKER-NEVER-OUTPUT";
function row(sourceKey: string, value: unknown): PrepareSitrepImportInput["rows"][number] {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return { sourceKey, sourceArea: "kv", encoding: "base64", rawBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}
function input(): PrepareSitrepImportInput {
  return {
    source: { spaceId: "isolated-review-origin", namespace: PREFIX, snapshotId: "review-base", completePrefixSnapshot: false },
    frozenAt: SITREP_NOW,
    rows: FROZEN_SITREP_RECORDS.map((record) => row(`${PREFIX}board/${record.kind}/${record.id}.json`, record)),
    publishers: [{ publisherId: "review-publisher", agentId: "review-owner-token", agentDid: "did:key:synthetic-review-publisher", outputResource: "xyz.tinycloud.tinychat/feed/feed_output_review", responseResource: "xyz.tinycloud.tinychat/feed/feed_responses_review" }],
    publisherBindings: FROZEN_SITREP_RECORDS.map((record) => ({ sourceKey: `${PREFIX}board/${record.kind}/${record.id}.json`, publisherId: "review-publisher", identity: { cardId: `review-${record.kind}-${record.id}`, revision: 1, issuanceId: `review-${record.kind}-issuance` } })),
    recipients: [
      { recipientKey: "review-officer", legacyName: "SyntheticOfficer", runtimeTarget: { agentId: "00000000-0000-4000-8000-000000000001", provider: "omp" } },
      { recipientKey: "review-owner", legacyName: "SyntheticOwner", runtimeTarget: { agentId: "00000000-0000-4000-8000-000000000002", provider: "omp" } },
      { recipientKey: "review-xo", legacyName: "xo" },
    ],
  };
}
function ask(changes: Record<string, unknown> = {}): Ask {
  const parsed = validateRecord("ask", { ...syntheticRecord("ask"), ...changes });
  if (!parsed.ok || parsed.value.kind !== "ask") throw new Error("Invalid synthetic review ask");
  return parsed.value;
}
function approval(changes: Record<string, unknown> = {}): Approval {
  const value = { ...syntheticRecord("approval"), ...changes };
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  const parsed = validateRecord("approval", value);
  if (!parsed.ok || parsed.value.kind !== "approval") throw new Error("Invalid synthetic review approval");
  return parsed.value;
}
function state(changes: Record<string, unknown>): SamState {
  const parsed = validateState({ kind: "task", id: "task-synthetic", steps: {}, ...changes });
  if (!parsed.ok) throw new Error("Invalid synthetic review state");
  return parsed.value;
}
function reply(at: string, text: string, extra: Partial<Answer> = {}): Answer {
  return { askId: "ask-synthetic", action: "answer", text, at, ...extra };
}
function question(bundle: PreparedSitrepImportBundle) {
  const card = bundle.cards.find((card) => card.record.kind === "ask");
  if (!card) throw new Error("Prepared review question is missing");
  return card;
}

for (const wrapper of ["sitrep", "source", "report"] as const) {
  test(`the ${wrapper} output wrapper rejects an extra owner-private field without stripping or leaking it`, async () => {
    const prepared = await prepareSitrepImport(input());
    const original = JSON.stringify(prepared);
    const changed = structuredClone(prepared);
    const payload = question(changed).canonicalCard.payload;
    if (wrapper === "sitrep") {
      const injected = { ...payload.sitrep, fullState: { privateNote: PRIVATE_MARKER } };
      payload.sitrep = injected;
    } else if (wrapper === "source") {
      const injected = { ...payload.source, fullState: { privateNote: PRIVATE_MARKER } };
      payload.source = injected;
    } else {
      const report = question(changed).record.links[0];
      if (!report) throw new Error("Synthetic review report source link is missing");
      payload.report = { label: report.label, url: report.url };
      await validatePreparedOwnerArchive(changed);
      payload.report = { ...payload.report, fullState: { privateNote: PRIVATE_MARKER } };
    }
    const submitted = JSON.stringify(changed);
    const failure = await validatePreparedOwnerArchive(changed).then(() => null, (error: unknown) => error);
    expect(failure instanceof Error).toBe(true);
    expect(inspect(failure, { depth: 20 })).not.toContain(PRIVATE_MARKER);
    expect(JSON.stringify(changed)).toBe(submitted);
    expect(JSON.stringify(prepared)).toBe(original);
  });
}

test("two equally unnormalized raw record copies cannot substitute for the validated canonical record", async () => {
  const changed = await prepareSitrepImport(input());
  const card = question(changed);
  card.record = { ...card.record, title: `  ${card.record.title}  ` };
  card.canonicalCard.payload.sitrep = { version: 1, record: { ...card.record } };
  const submitted = JSON.stringify(changed);
  await expect(validatePreparedOwnerArchive(changed)).rejects.toThrow();
  expect(JSON.stringify(changed)).toBe(submitted);
});

const immutableEvents = [
  { name: "answer", key: answerKey("ask-synthetic", AT), before: reply(AT, "The immutable original owner answer"), after: reply(AT, "A rewritten owner answer") },
  { name: "claim", key: claimDecisionKey("T-001", AT, NONCE), before: { choice: "keep", note: "Original decision", at: AT }, after: { choice: "remove", note: "Rewritten decision", at: AT } },
  { name: "thread", key: threadKey("sam", "ask", "ask-synthetic", AT, NONCE), before: { kind: "ask", id: "ask-synthetic", text: "The immutable original message", at: AT }, after: { kind: "ask", id: "ask-synthetic", text: "A rewritten message at the same full key", at: AT } },
] as const;
for (const event of immutableEvents) {
  for (const complete of [false, true]) {
    test(`${complete ? "complete" : "partial"} successors refuse rewritten ${event.name} bytes even with a valid replacement digest`, async () => {
      const initial = input();
      initial.rows.push(row(event.key, event.before));
      const previous = await prepareSitrepImport(initial);
      const saved = JSON.stringify(previous);
      const replacement = row(event.key, event.after);
      const successor = { ...initial, source: { ...initial.source, snapshotId: `rewritten-${event.name}-${complete}`, completePrefixSnapshot: complete }, rows: complete ? [...initial.rows.filter((item) => item.sourceKey !== event.key), replacement] : [replacement], previous };
      const rawInput = JSON.stringify(successor.rows);
      await expect(prepareSitrepImport(successor)).rejects.toThrow();
      expect(JSON.stringify(previous)).toBe(saved);
      expect(JSON.stringify(successor.rows)).toBe(rawInput);
    });
  }
  test(`an exact retry preserves the immutable ${event.name} source and transport identity`, async () => {
    const initial = input(); initial.rows.push(row(event.key, event.before));
    const first = await prepareSitrepImport(initial);
    const next = await prepareSitrepImport({ ...initial, source: { ...initial.source, snapshotId: `exact-${event.name}` }, previous: first });
    expect(next.sourceRows.find((item) => item.sourceKey === event.key)).toEqual(first.sourceRows.find((item) => item.sourceKey === event.key));
    expect(next.ownerResponses.filter((item) => item.sourceKey === event.key).map((item) => item.response.responseId)).toEqual(first.ownerResponses.filter((item) => item.sourceKey === event.key).map((item) => item.response.responseId));
  });
}

test("mutable card and private state successors remain admitted without rewriting prior snapshots", async () => {
  const initial = input();
  const key = `${PREFIX}sam/state/task/task-synthetic.json`;
  initial.rows.push(row(key, { kind: "task", id: "task-synthetic", steps: { verify: AT }, updatedAt: AT }));
  const previous = await prepareSitrepImport(initial);
  const priorBytes = JSON.stringify(previous);
  const next = await prepareSitrepImport({ ...initial, source: { ...initial.source, snapshotId: "mutable-successor" }, publisherBindings: initial.publisherBindings.map((binding) => binding.sourceKey === `${PREFIX}board/task/task-synthetic.json` ? { ...binding, identity: { ...binding.identity, revision: 2, issuanceId: "mutable-task-successor" } } : binding), rows: [row(`${PREFIX}board/task/task-synthetic.json`, { ...syntheticRecord("task"), title: "Updated mutable task title" }), row(key, { kind: "task", id: "task-synthetic", steps: { verify: null }, updatedAt: SITREP_NOW })], previous });
  expect(next.cards.find((card) => card.record.kind === "task")?.record.title).toBe("Updated mutable task title");
  expect(ownerDataFromPreparedBundle(next).states.find((item) => item.kind === "task")?.steps.verify).toBeNull();
  expect(JSON.stringify(previous)).toBe(priorBytes);
});

test("removing a source answer keeps its append-only owner history and current meaning, never new dispatch authority", async () => {
  const initial = input();
  const key = answerKey("ask-synthetic", AT);
  const oldAnswer = reply(AT, "The owner decision survives source removal", { choice: "quick" });
  const stateKey = `${PREFIX}sam/state/task/task-synthetic.json`;
  initial.rows.push(row(key, oldAnswer), row(stateKey, { kind: "task", id: "task-synthetic", steps: { verify: AT }, updatedAt: AT }));
  const first = await prepareSitrepImport(initial);
  const successor = await prepareSitrepImport({ ...initial, source: { ...initial.source, snapshotId: "answer-key-removed", completePrefixSnapshot: true }, rows: initial.rows.filter((item) => item.sourceKey !== key && item.sourceKey !== stateKey), previous: first });
  const owner = ownerDataFromPreparedBundle(successor);
  expect(owner.answers).toContainEqual({ sourceKey: key, card: { kind: "ask", id: "ask-synthetic" }, value: oldAnswer });
  expect(question(successor)).toMatchObject({ currentAnswerSourceKey: key, needsAction: false, attention: "handled" });
  expect(owner.states.some((item) => item.kind === "task" && item.id === "task-synthetic")).toBe(false);
  expect(successor.sourceRows.find((item) => item.sourceKey === key)).toEqual(first.sourceRows.find((item) => item.sourceKey === key));
  expect(successor.deletions).toContainEqual(expect.objectContaining({ sourceKey: key, classification: "answer" }));
  expect(successor.ownerResponses.filter((item) => item.sourceKey === key)).toEqual([]);
  expect(successor.deliveries.filter((item) => item.eventSourceKey === key && item.dispatch === "resolved-pending")).toEqual([]);
  const partial = await prepareSitrepImport({ ...initial, source: { ...initial.source, snapshotId: "after-answer-removal" }, rows: [], previous: successor });
  expect(ownerDataFromPreparedBundle(partial).answers).toContainEqual({ sourceKey: key, card: { kind: "ask", id: "ask-synthetic" }, value: oldAnswer });
});

test.each(["done", "code"] as const)("an approval %s for the same logical id cannot answer a question", (action) => {
  const question = ask();
  const consent = action === "code"
    ? approval({ id: question.id, approvalType: "openkey", approvalKind: undefined, codeExpected: true, names: ["REVIEW_KEY"], url: "https://openkey.so/delegate?fixture=review" })
    : approval({ id: question.id });
  const owner = emptySitrepOwnerData();
  const value = reply(AT, action === "code" ? "SYNTHETIC-PRIVATE-REVIEW-CODE" : "", { askId: question.id, action, issuedAt: consent.issuedAt });
  owner.answers.push({ sourceKey: "synthetic-approval-only", card: { kind: "approval", id: consent.id }, value });
  const view = projectSitrepCard(question, [question, consent], owner, Date.parse(SITREP_NOW));
  expect(view.answer).toBeUndefined();
  expect(view.needsAction).toBe(true);
  expect(projectSitrepCard(consent, [question, consent], owner, Date.parse(SITREP_NOW)).answer).toEqual(value);
});

test("a related folded step cannot borrow an unrelated approval's answer for its parent question", () => {
  const question = ask();
  const related = approval({ id: "review-secret-child", approvalType: "openkey", approvalKind: undefined, codeExpected: true, names: ["REVIEW_KEY"], url: "https://openkey.so/delegate?fixture=review", forAsk: { id: question.id } });
  const other = approval({ id: question.id });
  const owner = emptySitrepOwnerData();
  owner.answers.push({ sourceKey: "review-unrelated-approval", card: { kind: "approval", id: other.id }, value: reply(AT, "", { askId: other.id, action: "done", issuedAt: other.issuedAt }) });
  const view = projectSitrepCard(question, [question, related, other], owner, Date.parse(SITREP_NOW));
  expect(view.answer).toBeUndefined();
  expect(view.parts.map((part) => part.view.approval.id)).toEqual([related.id]);
  expect(view.parts[0]?.view.handled).toBe(false);
  expect(view.needsAction).toBe(true);
});

test("typed answer lookup respects its declared card id, not a value's unrelated askId", () => {
  const question = ask();
  const owner = emptySitrepOwnerData();
  owner.answers.push({ sourceKey: "review-other-card", card: { kind: "ask", id: "different-question" }, value: reply(AT, "Not owned by the displayed question") });
  expect(projectSitrepCard(question, [question], owner, Date.parse(SITREP_NOW)).answer).toBeUndefined();
});

test("folded consent is handled only by its own kind-and-id tagged owner answer", () => {
  const question = ask();
  const related = approval({ id: "review-secret-child", approvalType: "openkey", approvalKind: undefined, codeExpected: true, names: ["REVIEW_KEY"], url: "https://openkey.so/delegate?fixture=review", forAsk: { id: question.id } });
  const owner = emptySitrepOwnerData();
  const value = reply(AT, "SYNTHETIC-PRIVATE-REVIEW-CODE", { askId: related.id, action: "code", issuedAt: related.issuedAt });
  owner.answers.push({ sourceKey: "review-wrong-kind", card: { kind: "ask", id: related.id }, value });
  expect(projectSitrepCard(question, [question, related], owner, Date.parse(SITREP_NOW)).parts[0]?.view.handled).toBe(false);
  owner.answers.push({ sourceKey: "review-correct-kind", card: { kind: "approval", id: related.id }, value });
  expect(projectSitrepCard(question, [question, related], owner, Date.parse(SITREP_NOW)).parts[0]?.view.handled).toBe(true);
});

// Intentional correction approved by execution lead: timestamp fields remain
// authoritative, but accepted ISO offsets compare as instants, not as text.
test("the latest question answer uses its instant, not the lexical ISO offset or response sequence", () => {
  const question = ask();
  const early = reply("2026-10-29T13:00:00.000+02:00", "Earlier instant, lexically greater");
  const later = reply("2026-10-29T12:00:00.000Z", "Later instant, original timestamp retained");
  expect(currentAnswer(question, [early, later])).toBe(later);
  expect(currentAnswer(question, [later, early])).toBe(later);
});

test.each([
  ["2026-10-29T11:00:00.000Z", "2026-10-29T13:00:00.000+02:00"],
  ["2026-10-29T13:00:00.000+02:00", "2026-10-29T11:00:00.000Z"],
])("equal answer instants keep the first encountered value (%s, %s)", (firstAt, secondAt) => {
  const first = reply(firstAt, "First encountered owner answer");
  const second = reply(secondAt, "Second encountered owner answer");
  expect(currentAnswer(ask(), [first, second])).toBe(first);
});

test("the question reask instant is inclusive even when its source uses an offset", () => {
  const question = ask({ lastAskedAt: "2026-10-29T13:00:00.000+02:00" });
  const tooEarly = reply("2026-10-29T10:59:59.999Z", "Before the real asking instant");
  const boundary = reply(AT, "At the actual asking instant");
  expect(currentAnswer(question, [tooEarly])).toBeUndefined();
  expect(currentAnswer(question, [tooEarly, boundary])).toBe(boundary);
});

test("approval temporal eligibility parses the issuance instant without changing its exact identity string", () => {
  const consent = approval({ issuedAt: "2026-10-29T12:30:00.000+02:00", expiresAt: "2026-10-29T15:00:00.000+02:00" });
  const allowed = reply("2026-10-29T12:00:00.000Z", "", { askId: consent.id, action: "done", issuedAt: consent.issuedAt });
  expect(openApprovals([consent], [allowed], Date.parse(SITREP_NOW))[0]?.answer).toBe(allowed);
});

test("an approval answer at the issuance instant is eligible across timestamp spellings", () => {
  const consent = approval({ issuedAt: "2026-10-29T13:00:00.000+02:00", expiresAt: "2026-10-29T16:00:00.000+02:00" });
  const allowed = reply(AT, "", { askId: consent.id, action: "done", issuedAt: consent.issuedAt });
  expect(openApprovals([consent], [allowed], Date.parse(SITREP_NOW))[0]?.answer).toBe(allowed);
});

for (const at of ["2026-10-29T13:00:00.000Z", "2026-10-29T13:00:00.001Z"]) {
  test(`a go at or after the actual expiry instant is ineligible (${at})`, () => {
    const consent = approval({ issuedAt: "2026-10-29T09:00:00.000Z", expiresAt: "2026-10-29T15:00:00.000+02:00" });
    const stale = reply(at, "", { askId: consent.id, action: "done", issuedAt: consent.issuedAt });
    expect(openApprovals([consent], [stale], Date.parse(SITREP_NOW))[0]?.answer).toBeUndefined();
  });
}

test("equal issuance instants with different strings are different approval identities", () => {
  const consent = approval({ issuedAt: "2026-10-29T12:30:00.000+02:00", expiresAt: "2026-10-29T15:00:00.000+02:00" });
  const wrongIdentity = reply("2026-10-29T14:00:00.000+02:00", "", { askId: consent.id, action: "done", issuedAt: "2026-10-29T10:30:00.000Z" });
  expect(openApprovals([consent], [wrongIdentity], Date.parse(SITREP_NOW))[0]?.answer).toBeUndefined();
});

test("approval latest selection uses instants and preserves the first equal-instant answer", () => {
  const consent = approval({ issuedAt: "2026-10-29T09:00:00.000Z", expiresAt: "2026-10-29T20:00:00.000Z" });
  const first = reply(AT, "First equal-instant approval", { askId: consent.id, action: "done", issuedAt: consent.issuedAt });
  const equal = reply("2026-10-29T13:00:00.000+02:00", "Second equal-instant approval", { askId: consent.id, action: "done", issuedAt: consent.issuedAt });
  expect(openApprovals([consent], [first, equal], Date.parse(SITREP_NOW))[0]?.answer).toBe(first);
  const later = reply("2026-10-29T12:00:00.000Z", "Actually later approval", { askId: consent.id, action: "done", issuedAt: consent.issuedAt });
  expect(openApprovals([consent], [equal, later], Date.parse(SITREP_NOW))[0]?.answer).toBe(later);
});

test("timestamp-ordered state deltas compare instants and retain original offset strings", () => {
  const early = state({ steps: { verify: null }, updatedAt: "2026-10-29T13:00:00.000+02:00" });
  const later = state({ steps: { verify: SITREP_NOW }, updatedAt: "2026-10-29T12:00:00.000Z" });
  expect(mergeSitrepStates([later, early])[0]).toMatchObject({ steps: { verify: SITREP_NOW }, updatedAt: later.updatedAt });
});

test("equal state instants retain the existing deterministic JSON secondary order", () => {
  const off = state({ priority: { on: false, at: AT }, updatedAt: "2026-10-29T13:00:00.000+02:00" });
  const on = state({ priority: { on: true, at: AT }, updatedAt: AT });
  expect(mergeSitrepStates([on, off])[0]?.priority?.on).toBe(true);
  expect(mergeSitrepStates([off, on])[0]?.priority?.on).toBe(true);
});

test("provided state order stays commit-authoritative even when offsets reverse lexical order", () => {
  const first = state({ steps: { verify: SITREP_NOW }, updatedAt: "2026-10-29T12:00:00.000Z" });
  const last = state({ steps: { verify: null }, updatedAt: "2026-10-29T13:00:00.000+02:00" });
  expect(mergeSitrepStates([first, last], "provided")[0]).toMatchObject({ steps: { verify: null }, updatedAt: last.updatedAt });
  expect(mergeSitrepStates([last, first], "provided")[0]).toMatchObject({ steps: { verify: SITREP_NOW }, updatedAt: first.updatedAt });
});
