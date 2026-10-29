// What the page shows, derived from the records: pure functions over the board, Sam's answers and
// Sam's state. Replace a function here to change an ordering; the components only render.
import {
  type Answer,
  type Approval,
  type Ask,
  type BoardRecord,
  type ChatReceipt,
  type Incident,
  type Kind,
  type OfficerChat,
  type Order,
  type RecordOf,
  type SamChat,
  type SamState,
  type Ship,
  type Task,
  type Work,
  isClosed,
} from "./schema";
import { compareMatrix, effectivePriority } from "./priority";
import { depGraph, freedBy, pinLevel, unblockChain, waitsOnOthers } from "./deps";
import { cardPriority } from "./priority-flag";
import { DUE_WINDOW_MS, compareWaiting } from "./rank";

export interface BoardData {
  records: BoardRecord[];
  answers: Answer[];
  states: SamState[];
  samChat: SamChat[];
  officerChat: OfficerChat[];
  chatReceipt?: ChatReceipt;
}

export const byKind = <K extends Kind>(records: readonly BoardRecord[], kind: K): RecordOf<K>[] =>
  records.filter((record): record is RecordOf<K> => record.kind === kind);

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY);

/** Sam's latest answer that still counts: given after the ask was last (re)asked. */
export function currentAnswer(ask: Ask, answers: readonly Answer[]): Answer | undefined {
  const since = time(ask.lastAskedAt ?? ask.askedAt);
  let latest: Answer | undefined;
  for (const answer of answers) {
    if (answer.askId !== ask.id || Date.parse(answer.at) < since) continue;
    if (!latest || answer.at > latest.at) latest = answer;
  }
  return latest;
}

/**
 * Open blocking asks Sam still has something to do on, ordered by the shared matrix: the decision is
 * unanswered, or a part folded into the ask (askParts) is needed, unhandled and unexpired.
 * Steer questions have their own lane.
 */
export function needsYou(records: readonly BoardRecord[], answers: readonly Answer[], now: number = Date.now()): Ask[] {
  const { byAsk } = askParts(records, answers, now);
  return byKind(records, "ask")
    .filter((ask) => ask.status === "open" && !isSteer(ask) && (!currentAnswer(ask, answers) || (byAsk.get(ask.id) ?? []).some(partPending)))
    .sort(compareMatrix);
}

/** Asks Sam answered that the officer has not closed yet (and no part of theirs waits on him): shown as "sent, waiting for ack". */
export function awaitingAck(records: readonly BoardRecord[], answers: readonly Answer[], now: number = Date.now()): Array<{ ask: Ask; answer: Answer }> {
  const { byAsk } = askParts(records, answers, now);
  return byKind(records, "ask").flatMap((ask) => {
    const answer = ask.status === "open" ? currentAnswer(ask, answers) : undefined;
    return answer && !(byAsk.get(ask.id) ?? []).some(partPending) ? [{ ask, answer }] : [];
  });
}

/** Closed asks, newest first, with Sam's answer when there was one. */
export function askArchive(records: readonly BoardRecord[], answers: readonly Answer[]): Array<{ ask: Ask; answer?: Answer }> {
  return byKind(records, "ask")
    .filter((ask) => ask.status !== "open")
    .map((ask) => ({ ask, answer: currentAnswer(ask, answers) }))
    .sort((a, b) => (b.ask.closedAt ?? b.ask.updatedAt).localeCompare(a.ask.closedAt ?? a.ask.updatedAt));
}

// ── Steer questions ──────────────────────────────────────────────────

export const isSteer = (ask: Ask): boolean => ask.mode === "proceeding";

export type SteerState = "open" | "closed-proceeding" | "done" | "answered";

/**
 * Where a proceeding ask stands at `now`. answered: Sam answered (pass `answers`), or the officer closed
 * it before going ahead. done: the officer passed its point of no return (proceededAt). closed-proceeding:
 * decideBy has come (the window closes at that instant) and the officer is going ahead. open: the window is
 * still open. Sam can answer in every state.
 */
export function steerState(ask: Ask, now: number, answers: readonly Answer[] = []): SteerState {
  if (currentAnswer(ask, answers)) return "answered";
  if (ask.proceededAt) return "done";
  if (ask.status !== "open") return "answered";
  return ask.decideBy && Date.parse(ask.decideBy) <= now ? "closed-proceeding" : "open";
}

export interface SteerView {
  ask: Ask;
  state: Exclude<SteerState, "answered">;
}

const STEER_RANK = { open: 0, "closed-proceeding": 1, done: 2 } as const;

/** Open Steer questions Sam hasn't answered: open windows, then closed-proceeding, then done; matrix within each state. */
export function steerLane(records: readonly BoardRecord[], answers: readonly Answer[], now: number): SteerView[] {
  return byKind(records, "ask")
    .filter((ask) => isSteer(ask) && ask.status === "open")
    .flatMap((ask): SteerView[] => {
      const state = steerState(ask, now, answers);
      return state === "answered" ? [] : [{ ask, state }];
    })
    .sort((a, b) => STEER_RANK[a.state] - STEER_RANK[b.state] || compareMatrix(a.ask, b.ask));
}

/** The option a proceeding ask goes ahead with. */
export const steerDefault = (ask: Ask) => ask.options.find((option) => option.id === ask.default);

// ── Ask me later ─────────────────────────────────────────────────────

/** Sam snoozed this card and it is not due yet. It is due again at the instant snoozedUntil arrives. */
export function isSnoozed(state: SamState | undefined, now: number): boolean {
  return Boolean(state?.snoozedUntil) && Date.parse(state!.snoozedUntil!) > now;
}

/** Back on the list after a snooze: show the small marker until Sam clears it (snoozedUntil → null). */
export function backFromSnooze(state: SamState | undefined, now: number): boolean {
  return Boolean(state?.snoozedUntil) && !isSnoozed(state, now);
}

/**
 * isSnoozed for a card: an approval whose urgency rose after Sam's last snooze (urgencyRaisedAt) is
 * back at once, snoozedUntil untouched. Asks and tasks carry no such field, so they only come back when due.
 */
export function isSnoozedCard(record: { urgencyRaisedAt?: string } | undefined, state: SamState | undefined, now: number): boolean {
  return isSnoozed(state, now) && !returnedEarly(record, state, now);
}

/** Still inside its snooze, but the urgency rose after Sam set it: the card is back and wears the "Back from snooze" marker. */
export function returnedEarly(record: { urgencyRaisedAt?: string } | undefined, state: SamState | undefined, now: number): boolean {
  const lastSnooze = state?.snoozes?.at(-1)?.at;
  return isSnoozed(state, now) && Boolean(record?.urgencyRaisedAt && lastSnooze && Date.parse(record.urgencyRaisedAt) > Date.parse(lastSnooze));
}

export interface SnoozedItem<T> {
  item: T;
  until: string;
}

/** Splits cards into those to show and those snoozed (soonest back first). */
export function partitionSnoozed<T>(items: readonly T[], ref: (item: T) => { kind: Kind; id: string; record?: { urgencyRaisedAt?: string } }, states: readonly SamState[], now: number): { shown: T[]; snoozed: Array<SnoozedItem<T>> } {
  const shown: T[] = [];
  const snoozed: Array<SnoozedItem<T>> = [];
  for (const item of items) {
    const { kind, id, record } = ref(item);
    const state = stateFor(states, kind, id);
    if (isSnoozedCard(record, state, now)) snoozed.push({ item, until: state!.snoozedUntil! });
    else shown.push(item);
  }
  return { shown, snoozed: snoozed.sort((a, b) => a.until.localeCompare(b.until)) };
}

export type SnoozePresetId = "1h" | "tonight" | "tomorrow" | "next-week";
export interface SnoozePreset {
  id: SnoozePresetId;
  label: string;
  until: string;
}

/** The "Ask me later" choices, in the runtime's local timezone (Sam's browser): 1 h, 19:00, tomorrow 08:00, next Monday 08:00. */
export function snoozePresets(now: number): SnoozePreset[] {
  const at = (days: number, hour: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    return date;
  };
  const evening = at(0, 19);
  const pastEvening = evening.getTime() <= now;
  const toMonday = (8 - new Date(now).getDay()) % 7 || 7;
  return [
    { id: "1h", label: "In 1 hour", until: new Date(now + 3_600_000).toISOString() },
    { id: "tonight", label: pastEvening ? "Tomorrow evening" : "Tonight", until: (pastEvening ? at(1, 19) : evening).toISOString() },
    { id: "tomorrow", label: "Tomorrow morning", until: at(1, 8).toISOString() },
    { id: "next-week", label: "Next week", until: at(toMonday, 8).toISOString() },
  ];
}

export function stateFor(states: readonly SamState[], kind: Kind, id: string): SamState | undefined {
  return states.find((state) => state.kind === kind && state.id === id);
}

export interface TaskView {
  task: Task;
  done: number;
  total: number;
  checked: Record<string, boolean>;
}

/** Sam-only tasks still to do, ordered by the matrix; step ticks come from Sam's state. */
export function openTasks(records: readonly BoardRecord[], states: readonly SamState[]): TaskView[] {
  return byKind(records, "task")
    .filter((task) => task.status === "todo" && !stateFor(states, "task", task.id)?.dismissedAt)
    .sort(compareMatrix)
    .map((task) => {
      const ticks = stateFor(states, "task", task.id)?.steps ?? {};
      const checked = Object.fromEntries(task.steps.map((step) => [step.id, Boolean(ticks[step.id])]));
      return { task, checked, done: Object.values(checked).filter(Boolean).length, total: task.steps.length };
    });
}

// ── Approvals ────────────────────────────────────────────────────────

export interface ApprovalView {
  approval: Approval;
  /** Sam's latest code/done for this link (given after it was issued). */
  answer?: Answer;
  expired: boolean;
  /** Sam has done his part: a code pasted, "done" tapped, or the officer marked it answered. */
  handled: boolean;
  /** A secret card's read-grant step (an openkey approval with partOf = this id). */
  grant?: ApprovalView;
}

function approvalView(approval: Approval, answers: readonly Answer[], now: number, grant?: ApprovalView): ApprovalView {
  let answer: Answer | undefined;
  for (const candidate of answers) {
    if (candidate.askId !== approval.id || (candidate.action !== "code" && candidate.action !== "done") || candidate.at < approval.issuedAt) continue;
    // A go counts only for the issuance Sam saw, and only before its window closed (the watcher refuses both too).
    if (candidate.issuedAt && candidate.issuedAt !== approval.issuedAt) continue;
    if (approval.approvalType === "go" && approval.expiresAt && candidate.at >= approval.expiresAt) continue;
    if (!answer || candidate.at > answer.at) answer = candidate;
  }
  const own = approval.status === "answered" || Boolean(answer);
  return {
    approval,
    answer,
    grant,
    handled: own && (!grant || grant.handled),
    expired: approval.status === "expired" || (!own && Boolean(approval.expiresAt) && Date.parse(approval.expiresAt!) <= now),
  };
}

/**
 * Open approvals for Sam, with any read-grant step folded into its secret card; live links before
 * expired ones. A part folded into an ask (askParts) is not here: it shows inside that ask's card.
 */
export function openApprovals(records: readonly BoardRecord[], answers: readonly Answer[], now: number): ApprovalView[] {
  const { folded } = askParts(records, answers, now);
  const open = byKind(records, "approval").filter((approval) => !isClosed(approval) && !folded.has(approval.id));
  const ids = new Set(open.map((approval) => approval.id));
  return open
    .filter((approval) => !approval.partOf || !ids.has(approval.partOf))
    .map((approval) => {
      const step = open.find((candidate) => candidate.partOf === approval.id);
      return approvalView(approval, answers, now, step ? approvalView(step, answers, now) : undefined);
    })
    .sort((a, b) => Number(a.expired) - Number(b.expired) || compareMatrix(a.approval, b.approval));
}

// ── Parts of an ask (combined cards) ─────────────────────────────────

/** One part of an ask: a secret card (its read grant folded in) or a grant, drawn as a numbered step inside the ask's card. */
export interface AskPartView {
  view: ApprovalView;
  /** Sam need not do it: his current answer drops the ask or picks one of the part's skipOn options. Says which. */
  notNeeded?: string;
}

/** Sam did his part of this one record: a saved secret, a pasted code, or the officer marked it answered. */
export const approvalDone = (view: ApprovalView): boolean => view.approval.status === "answered" || Boolean(view.answer);

/** The officer closed this record early (done or cancelled) while its ask is still open. An expired record is not this: it shows as expired. */
export const approvalClosedEarly = (view: ApprovalView): boolean => isClosed(view.approval) && view.approval.status !== "expired";

/** The records of a part, each its own step: the card, then its folded grant. */
export const partSteps = (part: AskPartView): ApprovalView[] => (part.view.grant ? [part.view, part.view.grant] : [part.view]);

/** What one step of a part is at the moment: the state the card and the "steps done" line show. */
export type StepState = "pending" | "done" | "not needed" | "expired" | "closed";
export function stepState(part: AskPartView, step: ApprovalView): StepState {
  if (approvalClosedEarly(step)) return "closed";
  if (step.expired) return "expired";
  if (part.notNeeded) return "not needed";
  return approvalDone(step) ? "done" : "pending";
}

/** Sam still has something to do on this part: it is needed and some step is neither done, closed nor expired. A closed step is shown, never counted. */
export const partPending = (part: AskPartView): boolean => !part.notNeeded && partSteps(part).some((step) => stepState(part, step) === "pending");

/**
 * The one rule for folding. An approval is part of ask A only when it carries forAsk.id === A.id, A is
 * open and blocking (not Steer), the part is a secret card or a grant with names, and its officer
 * (`from`) is A's `from` or `owner`: the ask's poster consents to it by naming that officer. A part
 * that fails any test is not hidden; it renders on its own as it always did.
 */
export function foldsInto(part: Approval, ask: Ask): boolean {
  if (part.forAsk?.id !== ask.id || part.id === ask.id) return false;
  if (ask.status !== "open" || isSteer(ask)) return false;
  if (part.approvalType !== "secret" && !(part.approvalType === "openkey" && part.names?.length)) return false;
  return part.from === ask.from || part.from === ask.owner;
}

/**
 * Why Sam's current answer makes a part unnecessary, or undefined: he dropped the ask, or chose an
 * option in the part's skipOn (unknown option ids never match).
 */
function notNeededBy(part: Approval, ask: Ask, answer: Answer | undefined): string | undefined {
  if (!answer) return undefined;
  if (answer.action === "drop") return "you dropped the ask";
  const choice = answer.choice;
  if (choice && part.forAsk?.skipOn?.includes(choice)) return `you chose ${ask.options.find((option) => option.id === choice)?.label ?? choice}`;
  return undefined;
}

/**
 * The approvals folded into each open blocking ask, in the order the card shows them (createdAt, then
 * id; a read grant right after its secret card), and the set of every folded approval id. The page,
 * `waiting`, the watcher and card expiry all decide through this one function. A part whose id is an
 * ask id stays standalone: the watcher would read its code as an answer to that ask.
 */
export function askParts(records: readonly BoardRecord[], answers: readonly Answer[], now: number): { byAsk: Map<string, AskPartView[]>; folded: Set<string> } {
  const asks = byKind(records, "ask");
  const askIds = new Set(asks.map((ask) => ask.id));
  // Closed parts stay in the list so the card can show them as closed; they are never in `folded` (a closed record is off every list anyway).
  const all = byKind(records, "approval").filter((approval) => approval.forAsk && !askIds.has(approval.id));
  const byAsk = new Map<string, AskPartView[]>();
  const folded = new Set<string>();
  if (!all.length) return { byAsk, folded };
  for (const ask of asks) {
    const mine = all.filter((approval) => foldsInto(approval, ask));
    if (!mine.length) continue;
    const answer = currentAnswer(ask, answers);
    const ids = new Set(mine.map((approval) => approval.id));
    const roots = mine.filter((approval) => !approval.partOf || !ids.has(approval.partOf)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // A secret card carries one read grant; a second one is not hidden: it stays out of the fold and shows as a card of its own.
    const attached = new Set<string>();
    byAsk.set(ask.id, roots.map((root) => {
      const step = mine.find((candidate) => candidate.partOf === root.id);
      if (step) attached.add(step.id);
      return { view: approvalView(root, answers, now, step ? approvalView(step, answers, now) : undefined), notNeeded: notNeededBy(root, ask, answer) };
    }));
    for (const approval of mine) if (!isClosed(approval) && (roots.includes(approval) || attached.has(approval.id))) folded.add(approval.id);
  }
  return { byAsk, folded };
}

/** "a secret", "2 write grants", "2 steps": what an ask's pending parts are, for the Waiting row's "Ask + …". A secret card and its read grant are one part; a part named by what is still pending on it (its grant, once the secret card is closed). */
function partsLabel(parts: readonly AskPartView[]): string {
  const kinds = parts.map((part) => {
    const { approval } = partSteps(part).find((step) => stepState(part, step) === "pending") ?? part.view;
    return approval.approvalType === "secret" ? "secret" : approval.grantMode === "write" ? "write grant" : "read grant";
  });
  const one = new Set(kinds).size === 1 ? kinds[0]! : "step";
  return kinds.length === 1 ? `a ${one}` : `${kinds.length} ${one}s`;
}

// ── Waiting on you ───────────────────────────────────────────────────

export type WaitingKind = "ask" | "task" | "approval" | "work";
type WaitingRecord = Ask | Task | Approval | Work;

/** One row of Sam's "Waiting on you" list. */
export interface WaitingItem {
  kind: WaitingKind;
  record: WaitingRecord;
  /** Why it needs him now: the brief's whyNow; for work, what it waits on. */
  why?: string;
  /** What it holds up (the record's `blocks`). */
  blocks?: string;
  /** When the wait began: the ask's latest asking, the approval link's issue, the task's creation, the work item's last update. */
  since: string;
  urgency: number;
  importance: number;
  /** Holds up production or security (blocksProdOrSecurity): sorts first. */
  critical: boolean;
  /** Records this item unblocks, transitively (shared/deps.ts freedBy): open asks, tasks, approvals and active holds, each once. */
  unblocked: number;
  /** Of those, how many name production or security. */
  unblockedCritical: number;
  /** Dependency weight; a stated `blocks` claim with no graph edges counts as one. */
  unblockWeight: number;
  /** The earliest time Sam has to act by, as the status strip reads it: the card's deadline, and for an approval (or a step inside an ask) its deadline and link expiry. Undefined when nothing is dated. */
  deadlineAt?: number;
  /** deadlineAt is past or within DUE_WINDOW_MS of the moment the report was made. */
  dueSoon: boolean;
  /** 2 = Sam's priority pin (or an officer's flag he left on); 1 = it lifts a pinned card (it is upstream of one); 0 = neither. */
  pin: 0 | 1 | 2;
  /** It waits on a card that an officer, not Sam, has to act on first. */
  waitsOnOthers?: { by: string; title: string };
  /** The card's element id on the board. */
  anchor: string;
  /** An ask with parts folded in: what they add to it, as "Ask + 2 secrets". */
  label?: string;
  /** Anchors of the parts inside this ask's card, so a jump to one opens the card's group. */
  partAnchors?: string[];
  /** The "kind:id" of every record in this row that is still Sam's to act on: the row itself, each part step he has not done and the open read grant of a secret card. Not a part he did, one that is not needed or one that expired. */
  samKeys: string[];
}

/** An open item addressed to Sam that the list leaves out, and why. */
export interface NotWaiting {
  kind: WaitingKind;
  record: WaitingRecord;
  reason: string;
  /** Sam snoozed it: back on the list at this time. */
  snoozedUntil?: string;
  /** Snoozed: the records of the row that are his to act on (as WaitingItem.samKeys). */
  samKeys?: string[];
}

const PROD_OR_SECURITY = /\b(?:prod|production|security)\b/i;

/**
 * Holds up production or security: Sam's go on a release or deploy, or a card whose `blocks` names
 * prod, production or security as a whole word ("prod node logs", "security release"; not "product page").
 */
export function blocksProdOrSecurity(record: BoardRecord): boolean {
  if (record.kind === "approval" && record.approvalType === "go" && (record.approvalKind === "release" || record.approvalKind === "deploy")) return true;
  return Boolean(record.blocks && PROD_OR_SECURITY.test(record.blocks));
}

/**
 * The cards that are Sam's to act on, as "kind:id" keys: every row of his list (with the parts inside a
 * combined ask) and every snoozed card. Every other open card waits on its officer.
 */
export function waitingOnSamKeys(report: { waiting: readonly WaitingItem[]; notListed: readonly NotWaiting[] }): Set<string> {
  return new Set([
    ...report.waiting.flatMap((item) => item.samKeys),
    ...report.notListed.filter((entry) => entry.snoozedUntil).flatMap((entry) => entry.samKeys ?? [`${entry.kind}:${entry.record.id}`]),
  ]);
}

/**
 * Everything blocked on Sam, in one list: open blocking asks he has not answered, his to-do tasks,
 * approvals waiting on his part (a secret card and its read-grant step are one row), and work an
 * officer marked waiting-sam that no listed ask covers. Steer questions, answered or handled items,
 * expired links and snoozed cards are left out, each with its reason. A record with status
 * "expired" (card expiry) is neither listed nor reported: it no longer waits on anyone.
 */
export function waitingReport(data: Pick<BoardData, "records" | "answers" | "states">, now: number): { waiting: WaitingItem[]; notListed: NotWaiting[] } {
  const { answers, states } = data;
  const records = data.records.filter((record) => record.status !== "expired");
  const candidates: WaitingItem[] = [];
  const notListed: NotWaiting[] = [];
  const { byAsk, folded } = askParts(records, answers, now);
  const stepOpen = (step: ApprovalView) => !approvalDone(step) && !step.expired && !approvalClosedEarly(step);
  const add = (kind: WaitingKind, record: WaitingRecord, since: string, why: string | undefined, parts: readonly AskPartView[] = [], everyPart: readonly AskPartView[] = parts, grant?: ApprovalView) => {
    const { urgency, importance } = effectivePriority(record);
    // A combined card holds up what the ask and each part Sam still has to do hold up; a step its officer closed holds nothing.
    const open = parts.flatMap(partSteps).filter((step) => !approvalClosedEarly(step));
    // Dated like the strip: the card's own deadline, and each step Sam still has to do: its deadline and its link's expiry. An ask's or task's auto-expiry clock is not a deadline.
    const steps = [...open.filter(stepOpen), ...(grant && stepOpen(grant) ? [grant] : [])].map((step) => step.approval);
    const times = [(record as { deadline?: string }).deadline, ...(record.kind === "approval" ? [record.expiresAt] : []), ...steps.flatMap((step) => [step.deadline, step.expiresAt])].flatMap((iso) => (iso !== undefined && !Number.isNaN(Date.parse(iso)) ? [Date.parse(iso)] : []));
    const deadlineAt = times.length ? Math.min(...times) : undefined;
    const critical = blocksProdOrSecurity(record) || open.some((step) => blocksProdOrSecurity(step.approval));
    const grantOpen = grant !== undefined && stepOpen(grant);
    const samKeys = [`${kind}:${record.id}`, ...parts.flatMap((part) => partSteps(part).filter((step) => stepState(part, step) === "pending").map((step) => `approval:${step.approval.id}`)), ...(grantOpen ? [`approval:${grant.approval.id}`] : [])];
    candidates.push({ kind, record, since, why, samKeys, blocks: record.blocks, urgency, importance, critical, unblocked: 0, unblockedCritical: 0, unblockWeight: 0, deadlineAt, dueSoon: deadlineAt !== undefined && deadlineAt <= now + DUE_WINDOW_MS, pin: 0, anchor: `${kind}-${record.id}`, ...(parts.length ? { label: `Ask + ${partsLabel(parts)}` } : {}), ...(everyPart.length ? { partAnchors: everyPart.flatMap(partSteps).map((step) => `approval-${step.approval.id}`) } : {}) });
  };

  for (const ask of byKind(records, "ask")) {
    if (ask.status !== "open") continue;
    const answer = currentAnswer(ask, answers);
    const parts = byAsk.get(ask.id) ?? [];
    const pending = parts.filter(partPending);
    if (answer && !pending.length) notListed.push({ kind: "ask", record: ask, reason: `You answered at ${answer.at}; waiting for ${ask.from} to close it.` });
    else if (answer) add("ask", ask, ask.lastAskedAt ?? ask.askedAt, `You answered; ${pending.length} ${pending.length === 1 ? "step" : "steps"} left`, pending, parts);
    else if (isSteer(ask)) {
      const state = steerState(ask, now, answers);
      const choice = steerDefault(ask)?.label ?? ask.default;
      const when = state === "done" ? `went ahead with "${choice}"` : state === "closed-proceeding" ? `is going ahead with "${choice}" (window closed ${ask.decideBy})` : `goes ahead with "${choice}" at ${ask.decideBy}`;
      notListed.push({ kind: "ask", record: ask, reason: `Steer question: ${ask.from} ${when} unless you change it; it is in the Steer lane and blocks no one.` });
    } else add("ask", ask, ask.lastAskedAt ?? ask.askedAt, ask.context.whyNow, pending, parts);
    // Each folded record says why it has no row of its own.
    for (const part of parts) {
      for (const step of partSteps(part)) {
        const { approval } = step;
        const reason = approvalClosedEarly(step) ? `${approval.from} closed it (${approval.status}); it is shown inside the ask's card.`
          : part.notNeeded ? `Not needed: ${part.notNeeded}; ${approval.from} cancels it.`
          : approvalDone(step) ? `You did your part at ${step.answer?.at ?? approval.updatedAt}; waiting for ${approval.from} to finish and close it.`
          : step.expired ? `The link expired at ${approval.expiresAt}; ${approval.from} has to send a fresh one.`
          : `Part of ask ${ask.id}; that row covers it.`;
        notListed.push({ kind: "approval", record: approval, reason });
      }
    }
  }

  for (const task of byKind(records, "task")) {
    if (task.status !== "todo") continue;
    const state = stateFor(states, "task", task.id);
    const ticks = task.steps.map((step) => state?.steps[step.id]);
    if (state?.doneAt) notListed.push({ kind: "task", record: task, reason: `You marked it done at ${state.doneAt}.` });
    else if (state?.dismissedAt) notListed.push({ kind: "task", record: task, reason: `You dismissed it at ${state.dismissedAt}.` });
    else if (ticks.length && ticks.every(Boolean)) {
      const last = ticks.reduce((latest, at) => (at! > latest! ? at : latest));
      notListed.push({ kind: "task", record: task, reason: `You ticked every step (last at ${last}); waiting for ${task.from} to close it.` });
    } else add("task", task, task.createdAt, task.context.whyNow);
  }

  const open = byKind(records, "approval").filter((approval) => !isClosed(approval) && !folded.has(approval.id));
  const openIds = new Set(open.map((approval) => approval.id));
  for (const step of open) {
    if (step.partOf && openIds.has(step.partOf)) notListed.push({ kind: "approval", record: step, reason: `A step of ${step.partOf}; that row covers it.` });
  }
  for (const view of openApprovals(records, answers, now)) {
    const { approval } = view;
    if (view.expired) notListed.push({ kind: "approval", record: approval, reason: `The link expired at ${approval.expiresAt}; ${approval.from} has to send a fresh one.` });
    else if (view.handled) notListed.push({ kind: "approval", record: approval, reason: `You did your part at ${view.grant?.answer?.at ?? view.answer?.at ?? approval.updatedAt}; waiting for ${approval.from} to finish and close it.` });
    else add("approval", approval, approval.issuedAt, approval.context.whyNow, [], [], view.grant);
  }

  const listedAsks = new Set(candidates.filter((item) => item.kind === "ask").map((item) => item.record.id));
  for (const work of byKind(records, "work")) {
    if (work.status !== "waiting-sam") continue;
    const covering = work.askIds.find((id) => listedAsks.has(id));
    if (covering) notListed.push({ kind: "work", record: work, reason: `Waits on ask ${covering}, which is listed.` });
    // The board keeps no status-change time; the last update is the closest to when it began waiting.
    else add("work", work, work.updatedAt, work.waitsOn ?? work.next);
  }

  // The dependency index of this snapshot: whose turn each blocker is (the cards on Sam's list, snoozed ones too, are his) and which cards are pinned.
  const samOff = new Set(states.filter((state) => state.priority && !state.priority.on).map((state) => `${state.kind}:${state.id}`));
  const priorityOn = new Set(records.filter((record) => cardPriority(record, stateFor(states, record.kind, record.id)?.priority) !== null).map((record) => `${record.kind}:${record.id}`));
  const graph = depGraph(records, { waitingOnSam: new Set(candidates.flatMap((item) => item.samKeys)), priorityOn });
  for (const item of candidates) {
    const { record } = item;
    const cards = [record, ...item.samKeys.filter((key) => key !== `${item.kind}:${record.id}`).flatMap((key) => { const part = graph.record(key); return part ? [part] : []; })];
    const freed = freedBy(graph, cards, now);
    item.unblocked = freed.keys.length;
    item.unblockedCritical = freed.critical;
    item.unblockWeight = freed.weight;
    item.pin = Math.max(...cards.map((card) => pinLevel(graph, card.kind, card.id, unblockChain(graph, card.kind, card.id, now), samOff))) as 0 | 1 | 2;
    item.waitsOnOthers = waitsOnOthers(graph, item.kind, record.id);
  }

  const waiting: WaitingItem[] = [];
  for (const item of candidates) {
    const state = stateFor(states, item.kind, item.record.id);
    if (isSnoozedCard(item.record as { urgencyRaisedAt?: string }, state, now)) notListed.push({ kind: item.kind, record: item.record, reason: `Snoozed until ${state!.snoozedUntil}; it comes back on its own.`, snoozedUntil: state!.snoozedUntil!, samKeys: item.samKeys });
    else waiting.push(item);
  }
  return { waiting: waiting.sort(compareWaiting), notListed };
}

// ── The XO thread ────────────────────────────────────────────────────

export type DeliveryState = "saved" | "delivered" | "replied";

export type ThreadItem =
  | { side: "sam"; text: string; at: string; state: DeliveryState }
  | { side: "officer"; from: string; text: string; at: string; replyTo?: string };

/**
 * Sam's and the officers' messages in time order. A message of Sam's is "delivered" once the
 * watcher's receipt covers it, and "replied" once an officer answered it or anything after it.
 */
export function chatThread(data: Pick<BoardData, "samChat" | "officerChat" | "chatReceipt">): ThreadItem[] {
  const answeredThrough = data.officerChat.map((reply) => reply.replyTo ?? reply.at).sort().at(-1) ?? "";
  const deliveredThrough = data.chatReceipt?.deliveredThrough ?? "";
  const items: ThreadItem[] = [
    ...data.samChat.map((message): ThreadItem => ({
      side: "sam",
      text: message.text,
      at: message.at,
      state: message.at <= answeredThrough ? "replied" : message.at <= deliveredThrough ? "delivered" : "saved",
    })),
    ...data.officerChat.map((reply): ThreadItem => ({ side: "officer", from: reply.from, text: reply.text, at: reply.at, ...(reply.replyTo ? { replyTo: reply.replyTo } : {}) })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at) || (a.side === "sam" ? -1 : 1));
}

export const activeIncidents = (records: readonly BoardRecord[]): Incident[] =>
  byKind(records, "incident")
    .filter((incident) => incident.status !== "resolved")
    .sort(compareMatrix);

/** Resolved incidents from the last `days` days, newest first. */
export function recentIncidents(records: readonly BoardRecord[], now: number, days = 7): Incident[] {
  const since = now - days * 86_400_000;
  return byKind(records, "incident")
    .filter((incident) => incident.status === "resolved" && Date.parse(incident.resolvedAt ?? incident.updatedAt) >= since)
    .sort((a, b) => (b.resolvedAt ?? b.updatedAt).localeCompare(a.resolvedAt ?? a.updatedAt));
}

const WORK_RANK = { blocked: 0, "waiting-sam": 1, active: 2, "waiting-other": 3, done: 4 } as const;

/** Work in flight grouped by owning officer (the poster when no owner), busiest crew first. */
export function inFlightByOfficer(records: readonly BoardRecord[]): Array<{ officer: string; items: Work[] }> {
  const groups = new Map<string, Work[]>();
  for (const work of byKind(records, "work")) {
    if (isClosed(work)) continue;
    const officer = work.owner ?? work.from;
    groups.set(officer, [...(groups.get(officer) ?? []), work]);
  }
  return [...groups]
    .map(([officer, items]) => ({ officer, items: items.sort((a, b) => WORK_RANK[a.status] - WORK_RANK[b.status] || b.updatedAt.localeCompare(a.updatedAt)) }))
    .sort((a, b) => b.items.length - a.items.length || a.officer.localeCompare(b.officer));
}

export const shippedFeed = (records: readonly BoardRecord[]): Ship[] => byKind(records, "ship").sort((a, b) => b.at.localeCompare(a.at));

export const standingOrders = (records: readonly BoardRecord[]): Order[] =>
  byKind(records, "order")
    .filter((order) => order.status === "active")
    .sort((a, b) => b.at.localeCompare(a.at));

export interface Strip {
  openAsks: number;
  urgentAsks: number;
  activeIncidents: number;
  soonest?: { title: string; deadline: string; kind: "ask" | "task" | "approval"; source: "deadline" | "decide-by" | "link-expiry" };
}

/**
 * The readouts above the board. Next deadline is the earliest time Sam must act by, among awake
 * (not snoozed) items: an ask's or task's deadline, an open ask's Steer decideBy (until its window
 * closes), and, for an approval he has not done and whose link is still live, its deadline and the
 * link's own expiry. Overdue ones count. An ask's auto-expiry clock is not a deadline.
 */
export function statusStrip(data: Pick<BoardData, "records" | "answers" | "states">, now: number): Strip {
  const awake = (kind: Kind, id: string) => !isSnoozed(stateFor(data.states, kind, id), now);
  const asks = needsYou(data.records, data.answers, now).filter((ask) => awake("ask", ask.id));
  const tasks = openTasks(data.records, data.states)
    .map((view) => view.task)
    .filter((task) => awake("task", task.id));
  const dated: Array<NonNullable<Strip["soonest"]>> = [];
  const open = steerLane(data.records, data.answers, now).filter((view) => view.state === "open" && awake("ask", view.ask.id));
  for (const item of [...asks, ...tasks, ...open.map((view) => view.ask)]) if (item.deadline) dated.push({ title: item.title, deadline: item.deadline, kind: item.kind, source: "deadline" });
  for (const { ask } of open) if (ask.decideBy) dated.push({ title: ask.title, deadline: ask.decideBy, kind: "ask", source: "decide-by" });
  // Each step Sam still has to do, on the card he sees: standalone approvals, and parts inside an awake ask.
  const { byAsk } = askParts(data.records, data.answers, now);
  const pending: ApprovalView[] = [
    ...openApprovals(data.records, data.answers, now).filter((view) => awake("approval", view.approval.id)),
    ...asks.flatMap((ask) => (byAsk.get(ask.id) ?? []).filter(partPending).map((part) => part.view)),
  ];
  for (const view of pending) {
    for (const step of view.grant ? [view, view.grant] : [view]) {
      if (approvalDone(step) || step.expired) continue;
      const { title, deadline, expiresAt } = step.approval;
      if (deadline) dated.push({ title, deadline, kind: "approval", source: "deadline" });
      if (expiresAt) dated.push({ title, deadline: expiresAt, kind: "approval", source: "link-expiry" });
    }
  }
  const soonest = dated.sort((a, b) => time(a.deadline) - time(b.deadline))[0];
  return {
    openAsks: asks.length,
    urgentAsks: asks.filter((ask) => effectivePriority(ask).urgency >= 3).length,
    activeIncidents: activeIncidents(data.records).length,
    soonest,
  };
}

/** "2h 14m", "3d 4h", "overdue 12m". */
export function countdown(deadline: string, now: number): { label: string; overdue: boolean; hoursLeft: number } {
  const ms = Date.parse(deadline) - now;
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const span = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${String(mins).padStart(2, "0")}m` : `${mins}m`;
  return { label: ms < 0 ? `overdue ${span}` : span, overdue: ms < 0, hoursLeft: ms / 3_600_000 };
}

/** "just now", "12m ago", "3h ago", "2d ago". */
export function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

// ── Answer several ───────────────────────────────────────────────────

export interface ParsedReply {
  /** 1-based number Sam typed. */
  n: number;
  ask?: Ask;
  action: Answer["action"];
  choice?: string;
  text: string;
  /** Why the line could not be used, when it cannot. */
  problem?: string;
}

const ACCEPT_WORDS = /^(?:ok|okay|yes|yep|default|defaults(?: ok)?|rec(?:ommended)?|go|approved?|lgtm|sounds good|agree)[.!]?$/i;

/** Reads Sam's numbered batch ("1. drop it\n3 b, but only after 5pm") against the numbered asks. */
export function parseNumberedReplies(input: string, asks: readonly Ask[]): ParsedReply[] {
  const blocks: Array<{ n: number; lines: string[] }> = [];
  for (const raw of input.split(/\r?\n/)) {
    const head = /^\s*#?(\d{1,2})(?:\s*[.):\-–]|\s|$)\s*(.*)$/.exec(raw);
    if (head) blocks.push({ n: Number(head[1]), lines: [head[2] ?? ""] });
    else if (blocks.length && raw.trim()) blocks.at(-1)!.lines.push(raw.trim());
  }
  return blocks.map(({ n, lines }) => {
    const text = lines.join("\n").trim();
    const ask = asks[n - 1];
    if (!ask) return { n, action: "answer", text, problem: `there is no ask #${n}` };
    if (!text) return { n, ask, action: "answer", text, problem: "empty reply" };
    if (/^drop\b/i.test(text)) return { n, ask, action: "drop", text };
    if (ACCEPT_WORDS.test(text) && ask.recommend) return { n, ask, action: "accept-default", choice: ask.recommend, text };
    // An option named first, by its label or its id, is the choice; whatever follows is the note.
    const lower = text.toLowerCase();
    const byLabel = [...ask.options].sort((a, b) => b.label.length - a.label.length).find((option) => {
      const label = option.label.toLowerCase();
      return lower.startsWith(label) && /^(?:$|[\s]*[,:;.!)\-–—]|\s+(?=but|if|only|and|unless|then|please))/.test(lower.slice(label.length));
    });
    if (byLabel) return { n, ask, action: "answer", choice: byLabel.id, text: text.slice(byLabel.label.length).replace(/^[\s,:;.!)\-–—]+/, "").trim() };
    for (const option of ask.options) {
      const lead = new RegExp(`^\\(?${option.id.replace(/[-]/g, "\\-")}\\)?(?:$|[\\s]*[,:;.)\\-–—]\\s*|\\s+(?=but|if|only|and|unless|then|please|ok))`, "i").exec(text);
      if (lead) return { n, ask, action: "answer", choice: option.id, text: text.slice(lead[0].length).trim() };
    }
    return { n, ask, action: "answer", text };
  });
}

/** For a brief's related ask ids: the ask (if still on the board) and Sam's latest answer to it. */
export function relatedAnswers(ids: readonly string[], records: readonly BoardRecord[], answers: readonly Answer[]): Array<{ askId: string; ask?: Ask; answer?: Answer }> {
  return ids.map((askId) => {
    const ask = byKind(records, "ask").find((candidate) => candidate.id === askId);
    let answer: Answer | undefined;
    for (const candidate of answers) if (candidate.askId === askId && (!answer || candidate.at > answer.at)) answer = candidate;
    return { askId, ask, answer };
  });
}
