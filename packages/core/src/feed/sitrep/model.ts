import { askParts, currentAnswer, isSnoozedCard, openApprovals, partPending, partSteps, stateFor, waitingReport, type ApprovalView, type AskPartView } from "./board";
import { expiryOf } from "./expiry";
import { isClosed, isKind, validateAnswer, validateClaimDecision, validateRecord, validateState, type Answer, type BoardRecord, type ClaimDecision, type Kind, type SamState } from "./schema";
import { goStale } from "./transitions";
import { decodeOwnerThreadMessage, type OwnerThreadMessage } from "./thread-payload";
import type { SitrepCardPayload, SitrepOwnerData, SitrepMessageDelivery } from "./model-types";
import type { PreparedCard } from "./import-bundle";

export const SITREP_PAYLOAD_TYPES = ["sitrep.answer", "sitrep.state", "sitrep.claim", "sitrep.thread"] as const;
export type SitrepPayloadType = typeof SITREP_PAYLOAD_TYPES[number];
export type SitrepAction = { type: "sitrep.answer"; value: Answer } | { type: "sitrep.state"; value: SamState } | { type: "sitrep.claim"; value: ClaimDecision } | { type: "sitrep.thread"; value: OwnerThreadMessage; delivery?: SitrepMessageDelivery };
export interface SitrepProjection {
  record: BoardRecord;
  request: boolean;
  needsAction: boolean;
  attention: PreparedCard["attention"];
  state?: SamState;
  answer?: Answer;
  approval?: ApprovalView;
  parts: AskPartView[];
  foldedInto?: { kind: "ask"; id: string };
  expiryAt?: number | null;
}

export function emptySitrepOwnerData(): SitrepOwnerData {
  return { answers: [], states: [], claimDecisions: [], threads: [], deliveries: [] };
}

const NO_OWNER_ANSWERS: Answer[] = [];
Object.freeze(NO_OWNER_ANSWERS);

/** Keep the explicit owner tag through primary, folded and waiting lookups. */
export function ownerAnswerLookup(owner: Pick<SitrepOwnerData, "answers">): (kind: "ask" | "approval", id: string) => readonly Answer[] {
  const answers = new Map<string, Answer[]>();
  for (const entry of owner.answers) {
    if ((entry.card.kind !== "ask" && entry.card.kind !== "approval") || entry.card.id !== entry.value.askId) continue;
    const key = `${entry.card.kind}:${entry.card.id}`;
    const values = answers.get(key);
    if (values) values.push(entry.value); else answers.set(key, [entry.value]);
  }
  return (kind, id) => answers.get(`${kind}:${id}`) ?? NO_OWNER_ANSWERS;
}

/** src/lib/store.ts ClaimsSync: compare instants, then the full immutable source key. */
export function claimDecisionHistory(owner: SitrepOwnerData, id: string): SitrepOwnerData["claimDecisions"] {
  const history = new Map<string, SitrepOwnerData["claimDecisions"][number]>();
  for (const decision of owner.claimDecisions) {
    if (decision.card.kind !== "claim" || decision.card.id !== id) continue;
    const previous = history.get(decision.sourceKey);
    if (previous && JSON.stringify(previous.value) !== JSON.stringify(decision.value)) throw new Error("Conflicting immutable claim decision");
    history.set(decision.sourceKey, decision);
  }
  return [...history.values()].sort((a, b) => Date.parse(a.value.at) - Date.parse(b.value.at) || a.sourceKey.localeCompare(b.sourceKey));
}

/** src/components/Claims.tsx: a new decision follows the last even after clock rollback. */
export function nextClaimDecisionAt(owner: SitrepOwnerData, id: string, now: number): string {
  const latest = claimDecisionHistory(owner, id).at(-1)?.value.at;
  return new Date(Math.max(now, latest ? Date.parse(latest) + 1 : 0)).toISOString();
}

/** An invalid typed record is unsupported, not an actionable generic ask. */
export function parseSitrepCardPayload(value: unknown): SitrepCardPayload | null {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("record" in value)) return null;
  const record = value.record;
  if (!record || typeof record !== "object" || !("kind" in record) || typeof record.kind !== "string" || !isKind(record.kind)) return null;
  const checked = validateRecord(record.kind, record);
  return checked.ok ? { version: 1, record: checked.value } : null;
}

/** State payloads may be deltas. Append-only histories survive concurrent notes/ticks. */
export function mergeSitrepStates(events: readonly SamState[], order: "timestamp" | "provided" = "timestamp"): SamState[] {
  const states = new Map<string, SamState>();
  const ordered = order === "provided" ? events : [...events].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  for (const event of ordered) {
    const key = `${event.kind}:${event.id}`;
    const previous = states.get(key);
    if (!previous) { states.set(key, event); continue; }
    const notes = new Map((previous.notes ?? []).map((note) => [note.id ?? `${note.at}:${note.text}`, note]));
    for (const note of event.notes ?? []) notes.set(note.id ?? `${note.at}:${note.text}`, note);
    const snoozes = new Map((previous.snoozes ?? []).map((snooze) => [`${snooze.at}:${snooze.until}`, snooze]));
    for (const snooze of event.snoozes ?? []) snoozes.set(`${snooze.at}:${snooze.until}`, snooze);
    const clears = new Map((previous.clears ?? []).map((clear) => [clear.id, clear]));
    for (const clear of event.clears ?? []) clears.set(clear.id, clear);
    states.set(key, {
      ...previous, ...event, steps: { ...previous.steps, ...event.steps },
      ...(notes.size ? { notes: [...notes.values()].sort((a, b) => a.at.localeCompare(b.at) || String(a.id).localeCompare(String(b.id))) } : {}),
      ...(snoozes.size ? { snoozes: [...snoozes.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-20) } : {}),
      ...(clears.size ? { clears: [...clears.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-20) } : {}),
    });
  }
  return [...states.values()];
}

export function isSitrepRequest(record: BoardRecord): boolean {
  return record.kind === "ask" || record.kind === "task" || record.kind === "approval" || record.kind === "claim" || (record.kind === "hold" && record.releasedBy === "sam") || (record.kind === "work" && record.status === "waiting-sam");
}

/** Original answer timestamps and issuance, never transport sequence, decide attention. */
export function projectSitrepCard(record: BoardRecord, records: readonly BoardRecord[], owner: SitrepOwnerData, now: number): SitrepProjection {
  const answers = NO_OWNER_ANSWERS;
  const lookup = ownerAnswerLookup(owner);
  const state = stateFor(owner.states, record.kind, record.id);
  const folds = askParts(records, answers, now, lookup);
  const parts = record.kind === "ask" ? folds.byAsk.get(record.id) ?? [] : [];
  const base: SitrepProjection = { record, request: isSitrepRequest(record), needsAction: false, attention: "information", state, parts };
  if (record.kind === "ask" || record.kind === "task") base.expiryAt = expiryOf(record, state);
  if (record.kind === "ask") base.answer = currentAnswer(record, lookup("ask", record.id));
  if (record.kind === "approval") {
    base.approval = openApprovals(records, answers, now, lookup).find((view) => view.approval.id === record.id);
    for (const [askId, foldedParts] of folds.byAsk) {
      for (const part of foldedParts) {
        const step = partSteps(part).find((view) => view.approval.id === record.id);
        if (!step) continue;
        base.approval = step;
        base.foldedInto = { kind: "ask", id: askId };
        if (part.notNeeded) { base.attention = "not-needed"; return base; }
      }
    }
    base.answer = base.approval?.answer;
  }
  if (record.status === "expired" || base.approval?.expired) { base.attention = "expired"; return base; }
  if (isClosed(record)) { base.attention = "closed"; return base; }
  if (isSnoozedCard("urgencyRaisedAt" in record ? record : undefined, state, now)) { base.attention = "snoozed"; return base; }
  switch (record.kind) {
    case "ask": base.needsAction = !base.answer || parts.some(partPending); break;
    case "task": base.needsAction = record.status === "todo" && !state?.dismissedAt && !state?.doneAt && !(record.steps.length && record.steps.every((step) => Boolean(state?.steps[step.id]))); break;
    case "approval": base.needsAction = !base.approval?.handled; break;
    case "claim": base.needsAction = !owner.claimDecisions.some((decision) => decision.card.kind === "claim" && decision.card.id === record.id); break;
    case "hold": base.needsAction = record.status === "active" && record.releasedBy === "sam" && !state?.lift; break;
    case "work": base.needsAction = waitingReport({ records: [...records], answers, states: owner.states }, now, lookup).waiting.some((item) => item.kind === "work" && item.record.id === record.id); break;
  }
  base.attention = base.needsAction ? "needs-action" : base.request ? "handled" : "information";
  return base;
}

function invalid(message: string): never { throw new Error(message); }

/** Validate the addressed domain action before any real SQL write. */
export function validateSitrepAction(record: BoardRecord, type: string, data: unknown, now: string): SitrepAction {
  if (type === "sitrep.answer") {
    const parsed = validateAnswer(data);
    if (!parsed.ok) return invalid("Invalid typed Home answer");
    const answer = parsed.value;
    if (answer.askId !== record.id || (record.kind !== "ask" && record.kind !== "approval")) return invalid("Answer does not address this question or approval");
    if (record.kind === "ask") {
      if (!["answer", "drop", "accept-default"].includes(answer.action)) return invalid("This action is not a question response");
      if (answer.choice && !record.options.some((option) => option.id === answer.choice)) return invalid("Unknown question option");
    } else {
      if (answer.issuedAt !== record.issuedAt) return invalid("The approval was re-issued; open its current issuance");
      if (answer.action !== "code" && answer.action !== "done") return invalid("This approval requires a code or confirmation");
      if (record.approvalType === "go") {
        if (answer.action !== "done") return invalid("A go approval requires explicit confirmation");
        const stale = goStale(answer, record, now);
        if (stale) return invalid("Approval is stale or outside its current execution window");
      } else if (record.status !== "open" || (record.expiresAt && Date.parse(record.expiresAt) <= Date.parse(now))) return invalid("This approval is closed or expired");
    }
    return { type, value: answer };
  }
  if (type === "sitrep.state") {
    const parsed = validateState(data);
    if (!parsed.ok) return invalid("Invalid private owner state");
    const state = parsed.value;
    if (state.kind !== record.kind || state.id !== record.id) return invalid("Owner state does not address this card");
    if (Object.keys(state.steps).length && (record.kind !== "task" || Object.keys(state.steps).some((id) => !record.steps.some((step) => step.id === id)))) return invalid("Unknown task step");
    if (record.kind === "hold" && state.clears?.some((clear) => !record.unblockedBy.includes(clear.ref))) return invalid("Clear request does not address a blocker of this hold");
    return { type, value: state };
  }
  if (type === "sitrep.claim") {
    const parsed = validateClaimDecision(data);
    if (record.kind !== "claim" || !parsed.ok) return invalid("Invalid claim decision");
    return { type, value: parsed.value };
  }
  if (type === "sitrep.thread") {
    const decoded = decodeOwnerThreadMessage(record, data);
    if (isClosed(record)) return invalid("This card is closed; no new thread message can be sent");
    return { type, value: decoded.message, ...(decoded.delivery ? { delivery: decoded.delivery } : {}) };
  }
  return invalid("Unsupported typed Home response payload");
}

export function safeSitrepActionSummary(action: SitrepAction): string {
  switch (action.type) {
    case "sitrep.answer": return action.value.action === "code" ? "Approval code saved privately" : action.value.action === "done" ? "Approval confirmed for this issuance" : action.value.action === "drop" ? "Question dropped" : action.value.text || (action.value.choice ? `Selected ${action.value.choice}` : "Question answered");
    case "sitrep.state": return action.value.notes?.length ? "Note to owner saved" : action.value.clears?.length ? "Blocker clear requested" : action.value.lift ? "Hold lift requested" : action.value.snoozedUntil ? "Card snoozed" : action.value.doneAt ? "Task marked done" : "Owner state updated";
    case "sitrep.claim": return `Claim decision: ${action.value.choice}`;
    case "sitrep.thread": return action.value.resendOf ? "Card message resent explicitly" : "Card message saved";
  }
}

export function sameLegacyCard(record: BoardRecord, kind: Kind, id: string): boolean { return record.kind === kind && record.id === id; }
