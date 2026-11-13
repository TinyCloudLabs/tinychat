import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLinkIcon } from "lucide-react";
import type { FeedResponse, FeedResponsePayload, NewFeedMessage, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { cardPriority, claimDecisionHistory, compactStamp, depGraph, depTitle, expiryHint, isClosed, jsonValue, linkCaption, linkify, nextClaimDecisionAt, ownerThreadResponseKey, parseSitrepCardPayload, partSteps, projectSitrepCard, safeSitrepActionSummary, snoozePresets, steerState, stepState, threadOwner, validateSitrepAction, validateState, type Answer, type Approval, type BoardRecord, type SamState, type SitrepMessageDelivery, type SitrepOwnerData, type SitrepProjection, type StepState, type ThreadMessage, type SitrepHeldNote } from "@tinyboilerplate/core/feed/sitrep";
import { AnsweredPanel, ANSWER_FAILED_COPY, AnswerFailedLine, ErrorLine, FactRows, fieldClass as inputClass, NOT_SENT_COPY, PendingAnswer, UNDO_SECONDS, usePendingSend, fineClass, focusRing, kindWord, optionText, pillClass as buttonClass, quietClass, sourceRow, type FactRow } from "./cardKit";
import { AnswerOptions, OWN_OPTION, OwnAnswerBox, type AnswerOption } from "./AnswerOptions";
import { actionClass, CardDetails, footActionClass, type CardClose } from "./CardActions";
import { safeUrl } from "./feedData";
import { homeFeedKey } from "./feedIdentity";
import type { HomeFeedEntry, HomeFeedOwnerEvent, HomeFeedSource } from "./feedStoreTypes";
import { HistoryTimeline, type HistoryItem } from "./HistoryTimeline";
import { shortTime } from "./ShortTime";
import { useLeave } from "./leaveCard";
import { preloadModule } from "./preloadModule";

// The card's thread (its comments and closed comment box) loads beside the app, not in its startup chunk.
const useThreadModule = preloadModule(() => import("./HomeCardThread"));

function prose(text: string, repo?: string) { return linkify(text, repo).map((part, index) => "href" in part ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className="break-words underline underline-offset-[3px]">{part.label}</a> : part.text); }
const MEDIUM_MONTH = new Intl.DateTimeFormat("en-GB", { month: "short" });
/** A typed card's times, in the feed's medium style: "13 Nov, 09:00", with the year when it isn't this one. */
function stamp(at: string) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const year = date.getFullYear() === new Date().getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MEDIUM_MONTH.format(date)}${year}, ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
// An approval's kind in an owner's words (Monica, 11-13); a value with no plain word is left out, never shown raw.
const GO_WORDS: Record<string, string> = { release: "Go-ahead to release", deploy: "Go-ahead to deploy", spend: "Go-ahead to spend", publish: "Go-ahead to publish" };
const APPROVAL_WORDS: Record<string, string> = { go: "Go-ahead", openkey: "Approval in OpenKey", delegation: "Delegated access", claude: "Access for Claude", secret: "Access to a secret" };
function approvalWords(type: string, kind?: string): string | undefined {
  return type === "go" && kind && GO_WORDS[kind] ? GO_WORDS[kind] : APPROVAL_WORDS[type];
}
function id() { return crypto.randomUUID().replace(/-/g, ""); }
/** The countdown label of an ask's "Drop this card": it shows as "Dropping in Ns", and a refusal names the button. */
const DROP_LABEL = "Drop this card";
/** An approval's one action ("Give the go", "Save code", "I've done this step"): a normal-size dark button, as in the lab. */
const approveClass = "inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50";
const STEP_WORDS: Record<StepState, string> = { pending: "Waiting for you", done: "Done", "not needed": "Not needed", expired: "Ended", closed: "Closed" };
/** "A", "A and B", "A, B and C". */
function names(list: readonly string[]): string {
  return list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

interface Props {
  entry: HomeFeedEntry;
  record: BoardRecord;
  records: BoardRecord[];
  entries: HomeFeedEntry[];
  owner: SitrepOwnerData;
  projection: SitrepProjection;
  source: HomeFeedSource;
  now: number;
  /** Expanded in place: context, links, details and history show. */
  expanded?: boolean;
  /** A newer issuance replaced this card: drafts stay, but nothing more is sent for it. */
  stale?: boolean;
  /** An answer whose countdown ended after the card was replaced: nothing was written. */
  onRefused: (label: string) => void;
  /** The card reference, shown under Details. */
  reference?: ReactNode;
  /** At the right end of the card's foot: "Drop this card", while the card still needs you. The page owns the tap. */
  close?: CardClose;
  /** In place of Ask me later: "Bring back now" on a snoozed card. */
  extra?: ReactNode;
  onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void;
  onOwnerSaved: () => void;
  /** After Ask me later: the card has gone until `until`; the page says when it comes back, with Undo. */
  onSnoozed?: (until: string) => void;
  onNavigate: (entry: HomeFeedEntry) => void;
}

function OpenFoldedApproval({ approval, source, sourceId, onNavigate }: { approval: Approval; source: HomeFeedSource; sourceId: string; onNavigate: Props["onNavigate"] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function open() {
    setBusy(true); setError(undefined);
    try {
      const snapshot = await source.load();
      const matches = snapshot.entries.filter((candidate) => {
        const typed = parseSitrepCardPayload(candidate.state.card.payload?.sitrep);
        return candidate.source.sourceId === sourceId && typed?.record.kind === "approval" && typed.record.id === approval.id;
      });
      if (matches.length !== 1 || matches[0]!.currentIssuance === false) throw new Error("Current approval is not available");
      onNavigate(matches[0]!);
    } catch { setError("The new request couldn't be opened. Try again."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-1">
    <button type="button" disabled={busy} onClick={() => void open()} className="text-sm underline underline-offset-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open this step's own card.</button>
    {error && <ErrorLine>{error}</ErrorLine>}
  </div>;
}

/** Whether this answer has its saved transport record here, or is history restored from the owner archive. */
function answerReceipt(entry: HomeFeedEntry, owner: SitrepOwnerData, answer: Answer) {
  const original = owner.answers.find((row) => row.value === answer);
  const responseIds = original ? Object.entries(entry.owner?.responseOrigins ?? owner.responseOrigins ?? {}).flatMap(([responseId, origin]) => origin.sourceKey === original.sourceKey ? [responseId] : []) : [];
  const header = responseIds.length === 1 ? entry.responses?.find((response) => response.kind !== "message" && response.responseId === responseIds[0]) : undefined;
  const receipt = header ? entry.responseHandling?.[header.responseId] : undefined;
  const acknowledgement = receipt?.acknowledgement ?? (header && entry.state.acknowledgement?.responseId === header.responseId ? entry.state.acknowledgement : null);
  const outcome = receipt?.outcome ?? (header && entry.state.outcome?.responseId === header.responseId ? entry.state.outcome : null);
  return { header, acknowledgement, outcome };
}

/** The saved answer in words: the option's label (never its id); "got it" only once the agent acknowledged. */
function TypedAnswerStatus({ entry, owner, answer, record, focusOnMount = false }: { entry: HomeFeedEntry; owner: SitrepOwnerData; answer?: Answer; record: BoardRecord; focusOnMount?: boolean }) {
  if (!answer) return null;
  const { acknowledgement, outcome } = answerReceipt(entry, owner, answer);
  const agent = entry.source.label;
  const choice = answer.choice && record.kind === "ask" ? record.options.find((option) => option.id === answer.choice) : undefined;
  const label = choice && optionText(choice.label);
  const lead = answer.action === "code" ? `Code saved privately for ${agent}. It isn't shown again.`
    : answer.action === "drop" ? "You skipped this question."
      : answer.action === "done" ? record.kind === "approval" && record.approvalType === "go" ? "You gave the go." : "You marked this step done."
        : label ? <>You chose <b className="font-semibold">{label}</b>.</>
          : answer.choice ? "You chose an option that is no longer listed." : "You answered.";
  return <AnsweredPanel focusOnMount={focusOnMount}>
    <p>{lead}{acknowledgement && ` ${agent} got it.`}{outcome && (outcome.phase === "succeeded" ? ` ${agent} finished it.` : ` ${agent} couldn't finish it.`)}</p>
    {answer.action !== "code" && answer.text && <p className="whitespace-pre-wrap">{answer.text}</p>}
    {typeof outcome?.detail?.message === "string" && <p className="whitespace-pre-wrap">{outcome.detail.message}</p>}
  </AnsweredPanel>;
}

/** Owns its draft for one complete canonical identity, not a changing list index. */
export function SitrepCard(props: Props) {
  const { entry, record, records, entries, owner, projection, source, now, expanded = false, stale = false, reference, onRefused, onSaved, onOwnerSaved, onSnoozed } = props;
  const state = projection.state;
  const [text, setText] = useState("");
  const [ownOpen, setOwnOpen] = useState(false);
  // The option (or OWN_OPTION.id for a written answer) whose countdown or save is running, or whose save failed.
  const [chosen, setChosen] = useState<string>();
  const [justSaved, setJustSaved] = useState(false);
  // A decision (an option, its default or recommendation, Drop on an ask) takes the card away while it counts and is
  // written (leaveCard.ts); Undo, a failed write or a refusal brings it back. After the write it stays away until the
  // list moves it, or 8 s at most.
  const [decided, setDecided] = useState(false);
  const countdown = usePendingSend({ stale, onRefused: (label) => { setDecided(false); onRefused(label); } });
  const [reason, setReason] = useState("");
  const [claimNote, setClaimNote] = useState("");
  const [followup, setFollowup] = useState(false);
  const [later, setLater] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The answer whose send failed: whether it is still held is read when the line renders.
  const [failedAnswer, setFailedAnswer] = useState<string | null>(null);
  const answerId = useRef<string | undefined>(undefined);
  const [notice, setNotice] = useState<string>();
  const pending = useRef<{ key: string; header: NewFeedResponse | NewFeedMessage; payload: FeedResponsePayload } | undefined>(undefined);
  const privatePending = useRef<{ key: string; event: HomeFeedOwnerEvent } | undefined>(undefined);
  const heldPending = useRef<{ key: string; note: SitrepHeldNote } | undefined>(undefined);
  const busyRef = useRef(false);
  useEffect(() => {
    if (!decided || countdown.pending || busy) return;
    const timer = window.setTimeout(() => setDecided(false), 8000);
    return () => window.clearTimeout(timer);
  }, [decided, countdown.pending, busy]);
  const decisionUndo = () => { countdown.undo(); setChosen(undefined); setDecided(false); };
  const counting = countdown.pending;
  const words = !counting ? undefined
    : counting.label === DROP_LABEL ? { text: "Dropped" }
    : counting.label === NOT_SENT_COPY.yourAnswer ? { text: "Answered" }
    : { text: "Answered", choice: counting.label, ...(chosen && chosen !== OWN_OPTION.id ? { focusOption: chosen } : {}) };
  // An ask whose folded approval steps stay with Sam after its answer keeps its place; the bar still shows (the design agent).
  const pageBar = useLeave(decided ? { away: !projection.parts.length, ...(counting && words ? { bar: { ...words, endsAt: counting.endsAt, undo: decisionUndo } } : {}) } : null);
  const barred = pageBar && decided;
  const threadKit = useThreadModule();
  const closed = isClosed(record);
  const answers = owner.answers.filter((answer) => answer.card.kind === record.kind && answer.card.id === record.id).map((answer) => answer.value);
  const claims = claimDecisionHistory(owner, record.id);

  async function perform(work: () => Promise<unknown>, failure = "That wasn't saved. Try again.", answer = false): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true); setError(undefined); setFailedAnswer(null); setNotice(undefined);
    if (answer) answerId.current = undefined;
    try { await work(); return true; }
    catch { setError(failure); if (answer) { setFailedAnswer(answerId.current ?? ""); setDecided(false); } return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function send(type: string, data: unknown, operationKey: string, message = false, responseId?: string, hold = false) {
    // A replaced issuance is never answered: the owner answers the newer card instead.
    if (stale) throw new Error("This card was replaced by a newer one.");
    const action = validateSitrepAction(record, type, data, new Date().toISOString());
    let draft = pending.current?.key === operationKey ? pending.current : undefined;
    if (!draft) {
      const card = entry.state.card;
      const common = { responseId: responseId ?? crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, createdAt: "at" in action.value ? action.value.at : action.value.updatedAt, text: safeSitrepActionSummary(action) };
      const saved = entry.state.response;
      const selected = action.type === "sitrep.answer" ? action.value.choice : undefined;
      const header: NewFeedResponse | NewFeedMessage = message ? { ...common, kind: "message" } : { ...common, kind: saved ? "followup" : "answer", ...(saved ? { supersedesResponseId: saved.responseId } : {}), ...(selected && card.choices?.some((option) => option.id === selected) ? { choiceId: selected } : {}) };
      const data = action.type === "sitrep.thread" && action.delivery ? { ...action.value, delivery: action.delivery } : action.value;
      draft = { key: operationKey, header, payload: { type, version: 1, data: jsonValue(data) } };
      pending.current = draft;
    }
    let result: FeedResponse;
    if (draft.header.kind === "message") {
      if (!source.sendMessage) throw new Error("This feed source does not provide durable card messaging");
      result = await source.sendMessage(entry, draft.header, draft.payload);
    } else { answerId.current = draft.header.responseId; result = await source.saveResponse(entry, draft.header, draft.payload, { hold }); }
    pending.current = undefined;
    onSaved(entry, result);
    onOwnerSaved();
  }
  async function savePrivate(patch: Partial<SamState>, operationKey: string) {
    if (!source.saveOwnerState) throw new Error("This feed source does not provide private owner storage");
    let draft = privatePending.current?.key === operationKey ? privatePending.current : undefined;
    if (!draft) {
      const parsed = validateState({ kind: record.kind, id: record.id, steps: {}, updatedAt: new Date().toISOString(), ...patch });
      if (!parsed.ok) throw new Error("Invalid private owner update");
      // Check aggregate limits before appending a delta, without copying private
      // data into the agent-readable response database.
      const aggregate = validateState({ ...state, ...parsed.value, steps: { ...state?.steps, ...parsed.value.steps }, ...(parsed.value.notes ? { notes: [...(state?.notes ?? []), ...parsed.value.notes] } : {}) });
      if (!aggregate.ok) throw new Error("Private owner history exceeds a supported limit");
      draft = { key: operationKey, event: { eventId: crypto.randomUUID(), state: parsed.value } };
      privatePending.current = draft;
    }
    await source.saveOwnerState(entry, draft.event); privatePending.current = undefined; onOwnerSaved();
    return draft.event;
  }
  /** `hold`: an answer from the undo countdown, held in the page-close outbox until its write is confirmed. */
  async function askAnswer(action: "answer" | "drop" | "accept-default" = "answer", selected?: string, hold = false) {
    if (record.kind !== "ask") return;
    await send("sitrep.answer", { askId: record.id, action, ...(selected ? { choice: selected } : {}), text, at: new Date().toISOString() }, `ask:${action}:${selected ?? ""}:${text}`, false, undefined, hold);
    setText(""); setOwnOpen(false); setChosen(undefined); setFollowup(false); setJustSaved(true);
  }
  /** One tap (or Send under "Your own answer") chooses: the answer waits out the undo window in its row, then is held and sent. */
  function choose(choice: string, label: string) {
    if (stale || busyRef.current || countdown.pending) return;
    setChosen(choice); setDecided(true);
    const own = choice === OWN_OPTION.id;
    countdown.start(own ? NOT_SENT_COPY.yourAnswer : label, () => void perform(() => askAnswer("answer", own ? undefined : choice, true), ANSWER_FAILED_COPY, true));
  }
  async function command(patch: Partial<SamState>, key: string) {
    const matching = owner.commands?.filter((event) => patch.doneAt ? !!event.state.doneAt : patch.lift ? !!event.state.lift : patch.clears?.some((request) => event.state.clears?.some((prior) => prior.ref === request.ref))).at(-1);
    const event = matching ?? await savePrivate(patch, key);
    const value = event.state;
    const selectedClear = patch.clears?.[0]?.ref;
    const data = { kind: record.kind, id: record.id, steps: {}, updatedAt: value.updatedAt, ...(patch.doneAt && value.doneAt ? { doneAt: value.doneAt } : {}), ...(patch.lift && value.lift ? { lift: value.lift } : {}), ...(selectedClear ? { clears: value.clears?.filter((request) => request.ref === selectedClear) } : {}) };
    await send("sitrep.state", data, `command:${event.eventId}`, true, event.eventId);
    setNotice(`Saved. ${entry.source.label} confirms when it's done.`);
  }
  /**
   * An agent-bound action that is not an option (accepting the default, dropping the question, task done, a claim
   * decision, a blocker clear, a hold lift) waits out the same undo window under PendingAnswer, then writes; `run`
   * makes its timestamps when it is written, not at the tap. `answer`: a decision held in the page-close outbox,
   * whose failure says whether it is still held.
   */
  function afterUndo(label: string, run: () => Promise<unknown>, answer = false) {
    if (stale || busyRef.current || countdown.pending) return;
    // An ask's decision (its default, its recommendation, Drop) leaves with the bar's "Answered"/"Dropped"; a claim's
    // or an approval's keeps its countdown in the card (no bar wording for them yet).
    setChosen(undefined); if (answer && record.kind === "ask") setDecided(true);
    countdown.start(label, () => void perform(run, answer ? ANSWER_FAILED_COPY : undefined, answer));
  }
  function threadMessage(value: string, resendOf?: string): ThreadMessage {
    const at = new Date().toISOString();
    return { side: "sam", kind: record.kind, id: record.id, at, text: value, messageId: `${compactStamp(at)}-${id()}`, ...(resendOf ? { resendOf } : {}) };
  }
  async function sendThread(value: string, resendOf?: string, toOwner = false) {
    if (toOwner && !destinations.length) throw new Error("The intended owner has no approved destination");
    let delivery: SitrepMessageDelivery | undefined = toOwner ? { version: 1, targets: destinations.map((recipient) => ({ recipientKey: recipient.recipientKey, agentId: recipient.runtimeTarget.agentId, ...(recipient.runtimeTarget.provider ? { provider: recipient.runtimeTarget.provider } : {}) })) } : undefined;
    if (resendOf) {
      const original = owner.threads.find((message) => message.side === "sam" && message.kind === record.kind && message.id === record.id && message.messageId === resendOf);
      const originalRoute = original && entry.threadRoutes?.[ownerThreadResponseKey(original)];
      if (!originalRoute || originalRoute.kind === "held") throw new Error("The original logical destination is not approved; the message remains held");
      delivery = originalRoute.kind === "recipients" ? originalRoute.delivery : undefined;
    }
    await send("sitrep.thread", { ...threadMessage(value, resendOf), ...(delivery ? { delivery } : {}) }, `thread:${resendOf ?? ""}:${JSON.stringify(delivery)}:${value}`, true);
  }
  async function holdNote(value: string) {
    if (!source.saveHeldNote) throw new Error("This feed source does not provide private held-note storage");
    const intendedRecipient = unresolved.join(" / ") || ownerLabel;
    const key = `${intendedRecipient}:${value}`;
    const pending = heldPending.current?.key === key ? heldPending.current : { key, note: { eventId: crypto.randomUUID(), at: new Date().toISOString(), text: value, intendedRecipient } };
    heldPending.current = pending;
    await source.saveHeldNote(entry, pending.note);
    onOwnerSaved();
  }
  /**
   * A message from the card's thread composer. With an owner route on this card it goes
   * only to the owner-approved destinations (unresolved recipients are held privately);
   * without one it goes to the publishing agent.
   */
  async function messageAgent(value: string) {
    if (route) {
      if (!routeReady || unresolved.length) await holdNote(value);
      if (routeReady) await sendThread(value, undefined, true);
      heldPending.current = undefined;
      if (routeReady && unresolved.length) setNotice(`Sent to ${destinations.map((recipient) => recipient.legacyName).join(" / ")}. ${unresolved.join(" / ")}: kept private, not sent.`);
    } else await sendThread(value);
  }
  const graph = depGraph(records);
  const dependencies = "unblockedBy" in record ? record.unblockedBy ?? [] : [];
  const pinned = cardPriority(record, state?.priority);
  const ownerLabel = threadOwner(record);
  const route = entry.recipientRoute;
  const destinations = route?.recipients.flatMap((recipient) => recipient.runtimeTarget ? [{ ...recipient, runtimeTarget: recipient.runtimeTarget }] : []) ?? [];
  const unresolved = [...new Set([...(route?.unresolved ?? []), ...(route?.recipients.filter((recipient) => !recipient.runtimeTarget).map((recipient) => recipient.legacyName) ?? [])])];
  const routeReady = destinations.length > 0;
  const agent = entry.source.label;
  const responds = entry.state.card.needsResponse && !closed;
  const asking = record.kind === "ask" && responds && (!projection.answer || followup || !!text.trim());
  const snoozed = Date.parse(entry.view.snoozedUntil ?? "") > now;
  const hint = expiryHint(record, now, state);
  // An ask's or task's timing under its body, in the feed's words (Monica, TC-2982): "Due 13 Nov, 6:00 PM · Expires
  // 14 Nov, 2:48 PM · in 2 h". A card that never expires says nothing about it.
  const timing = record.kind === "ask" || record.kind === "task"
    ? [record.deadline && `Due ${shortTime(record.deadline, now)}`, projection.expiryAt && `Expires ${shortTime(new Date(projection.expiryAt).toISOString(), now)}`, hint?.replace(/^expires in (\d+)h$/, "in $1 h")].filter(Boolean).join(" · ")
    : "";
  const receipt = projection.answer && answerReceipt(entry, owner, projection.answer);
  const options: AnswerOption[] = record.kind === "ask" ? record.options.map((option) => ({ id: option.id, label: option.label, ...(option.detail ? { detail: option.detail } : {}), ...(option.cost ? { cost: option.cost } : {}) })) : [];
  const steer = record.kind === "ask" && record.mode === "proceeding" ? steerState(record, now, answers) : undefined;
  const optionLabel = (optionId?: string) => { const option = record.kind === "ask" ? record.options.find((candidate) => candidate.id === optionId) : undefined; return option && optionText(option.label); };
  // The card's history under Details, oldest first: posted, then each answer and snooze; the latest is current.
  const history: HistoryItem[] = [
    { key: "posted", at: entry.state.card.createdAt, title: "Posted" },
    ...answers.map((answer, index) => ({ key: `answer:${answer.at}:${index}`, at: answer.at,
      title: answer.action === "code" ? "Code saved privately" : answer.action === "drop" ? "Skipped" : answer.action === "done" ? "Done" : `Chose ${optionLabel(answer.choice) ?? (answer.choice ? "an option no longer listed" : "a written answer")}`,
      ...(answer.action !== "code" && answer.text ? { detail: answer.text } : {}) })),
    ...(state?.snoozes ?? []).map((snooze) => ({ key: `snooze:${snooze.at}:${snooze.until}`, at: snooze.at, title: `Snoozed until ${stamp(snooze.until)}` })),
  ].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)).map((item, index, all) => ({ ...item, tone: index === all.length - 1 ? "current" as const : "done" as const }));

  // Who a comment reaches: the owner-approved recipients; with none approved, who it is kept for privately; else the agent.
  // The conversation keeps its own closed box ("Leave a comment for …") above the foot, as on the lab's cards.
  const commentTo = closed ? undefined : destinations.length ? names(destinations.map((recipient) => recipient.legacyName)) : route ? names(unresolved.length ? unresolved : [ownerLabel]) : agent;
  const thread = threadKit && <threadKit.HomeCardThread entry={entry} record={record} owner={owner} busy={busy} closed={closed} now={now} open={expanded} stale={stale} to={commentTo}
    onSend={(value) => perform(() => messageAgent(value))} onResend={(value, resendOf) => perform(() => sendThread(value, resendOf))} />;
  // A non-option action counting down, with "Undo · N"; it stands where the card's controls were. An option's own
  // countdown (`chosen`) shows in its row instead.
  // An ask's "Drop this card" says what is happening while it waits, with the same Undo as a comment's (Monica).
  const pendingLine = countdown.pending && !chosen && !barred && (countdown.pending.label === DROP_LABEL
    ? <><p className="mt-3.5 flex items-center gap-x-1.5 text-sm text-muted-foreground"><span className="tabular-nums">Dropping in {countdown.pending.seconds}s</span><span aria-hidden>·</span>
      <button type="button" onClick={countdown.undo} className="relative min-h-11 rounded-sm font-medium text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-9">Undo</button></p>
      <p role="status" className="sr-only">Dropping this card in {UNDO_SECONDS} seconds. Undo is available until then.</p></>
    : <PendingAnswer label={countdown.pending.label} seconds={countdown.pending.seconds} onUndo={countdown.undo}>
      <p>Sending <b className="font-semibold">{countdown.pending.label}</b>…</p>
    </PendingAnswer>);
  const waiting = !!countdown.pending;
  const failed = failedAnswer !== null;

  return <div className="text-[15px]" aria-label={`${kindWord(record.kind)} details`}>
    {/* The agent's context in a shaded panel, ahead of what it asks of you. */}
    {"context" in record && <div className="mt-4 space-y-2 rounded-xl bg-muted/30 p-4 text-sm"><p>{prose(record.context.background, record.repo)}</p>{record.context.whyNow && <p><strong className="font-semibold">Why now: </strong>{prose(record.context.whyNow, record.repo)}</p>}{record.context.ifNoAnswer && <p><strong className="font-semibold">If no answer: </strong>{prose(record.context.ifNoAnswer, record.repo)}</p>}{!!record.context.known.length && <ul className="list-disc space-y-1 pl-5">{record.context.known.map((known, index) => <li key={index}>{prose(known, record.repo)}</li>)}</ul>}{!!record.context.related.length && <p>Earlier questions: {record.context.related.join(", ")}</p>}</div>}
    {timing && <p className="mt-3 text-xs text-muted-foreground">{timing}</p>}
    {record.kind !== "ask" && record.kind !== "task" && hint && <p className="mt-2 text-[13px] font-medium text-warning">{hint.replace(/^expires/, "Expires")}</p>}

    {record.kind === "ask" && <>
      {pendingLine}
      {!countdown.pending && !asking && <TypedAnswerStatus entry={entry} owner={owner} answer={projection.answer} record={record} focusOnMount={justSaved} />}
      {!countdown.pending && asking && followup && <p className="mt-3.5 text-[13px] text-muted-foreground">A new answer replaces your earlier one. It can't undo what {agent} already did.</p>}
      {asking && <div className="mt-3.5"><AnswerOptions options={options} suggested={record.recommend} disabled={stale}
        pending={!barred && countdown.pending && chosen ? { choiceId: chosen, seconds: countdown.pending.seconds } : null}
        saving={busy ? chosen : undefined} chosen={failed ? chosen : undefined}
        onChoose={choose} onUndo={decisionUndo}
        own={{ open: ownOpen || !options.length, onOpen: setOwnOpen, box: <OwnAnswerBox text={text} disabled={waiting || busy} onText={setText} onSend={() => { if (text.trim()) choose(OWN_OPTION.id, OWN_OPTION.label); }} onCancel={() => { setText(""); setOwnOpen(false); }}
          state={chosen === OWN_OPTION.id ? (busy ? "sending" : failed ? "error" : "idle") : "idle"} onRetry={() => void perform(() => askAnswer("answer", undefined, true), ANSWER_FAILED_COPY, true)} /> }} /></div>}
      {!waiting && asking && ((steer === "open" && record.default) || record.recommend) && <div className="mt-3 flex flex-wrap gap-2">
        {steer === "open" && record.default && <button type="button" className={actionClass} disabled={busy || stale} onClick={() => afterUndo(optionLabel(record.default) ?? "its plan", () => askAnswer("accept-default", record.default, true), true)}>Fine, go ahead</button>}
        {record.recommend && <button type="button" className={actionClass} disabled={busy || stale} onClick={() => afterUndo(optionLabel(record.recommend) ?? "the recommendation", () => askAnswer("accept-default", record.recommend, true), true)}>Accept recommendation</button>}
      </div>}
      {!waiting && asking && steer === "open" && record.default && <p className={`mt-2 ${fineClass}`}>{agent} goes ahead with {optionLabel(record.default) ?? "its plan"}{record.decideBy && ` at ${stamp(record.decideBy)}`} unless you choose.</p>}
      {!waiting && responds && (!asking || followup) && <div className="mt-1 flex flex-wrap gap-x-[26px]">
        {!asking && projection.answer?.action !== "drop" && <button type="button" className={quietClass} onClick={() => { setFollowup(true); setJustSaved(false); }}>Change answer</button>}
        {followup && <button type="button" className={quietClass} disabled={busy} onClick={() => { setFollowup(false); setText(""); setOwnOpen(false); setChosen(undefined); }}>Keep my answer</button>}
      </div>}
      {projection.parts.map((part) => <section key={part.view.approval.id} className="mt-3.5 space-y-3" aria-label="Folded approval step">{partSteps(part).map((step) => {
        const matches = entries.filter((candidate) => { const typed = parseSitrepCardPayload(candidate.state.card.payload?.sitrep); return typed?.record.kind === "approval" && typed.record.id === step.approval.id; });
        const target = matches.length === 1 ? matches[0] : undefined;
        return <div key={step.approval.id} className="space-y-1"><p className="font-semibold">{step.approval.title}</p><p className={fineClass}>{STEP_WORDS[stepState(part, step)]}{part.notNeeded && ` · ${part.notNeeded}`}</p>
          {target ? <ApprovalActions entry={target} approval={step.approval} source={source} owner={owner} stale={stale} onSaved={onSaved} onOwnerSaved={onOwnerSaved} onNavigate={props.onNavigate} showStatus inactive={stepState(part, step) !== "pending"} /> : stepState(part, step) === "pending" && <OpenFoldedApproval approval={step.approval} source={source} sourceId={entry.source.sourceId} onNavigate={props.onNavigate} />}
        </div>;
      })}</section>)}
    </>}

    {record.kind === "approval" && <><TypedAnswerStatus entry={entry} owner={owner} answer={projection.answer} record={record} /><ApprovalActions entry={entry} approval={record} source={source} owner={owner} stale={stale} onSaved={onSaved} onOwnerSaved={onOwnerSaved} onNavigate={props.onNavigate} inactive={projection.attention === "not-needed"} /></>}
    {record.kind === "task" && <div className="mt-3.5 space-y-2">
      <fieldset disabled={busy || closed || !entry.state.card.needsResponse}><legend className="sr-only">{entry.state.card.needsResponse ? "Your steps (private)" : "Steps"}</legend>
        {record.steps.map((step) => <label key={step.id} className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-5 accent-foreground" checked={!!state?.steps[step.id]} onChange={(event) => { const checked = event.currentTarget.checked; void perform(() => savePrivate({ steps: { [step.id]: checked ? new Date().toISOString() : null } }, `tick:${step.id}:${checked}`)); }} /><span className={state?.steps[step.id] ? "text-muted-foreground line-through" : ""}>{step.text}</span></label>)}
      </fieldset>
      {record.chatLink && safeUrl(record.chatLink) && <a href={record.chatLink} target="_blank" rel="noopener noreferrer" className={`inline-flex min-h-11 items-center text-sm underline underline-offset-[3px] ${focusRing}`}>Open task context</a>}
      {entry.state.card.needsResponse && !waiting && <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><button type="button" className={buttonClass} disabled={busy || closed || stale} onClick={() => afterUndo(state?.doneAt ? "Send “done” again" : "Mark done", () => { const at = new Date().toISOString(); return command({ doneAt: at, dismissedAt: at }, "task-done"); })}>{state?.doneAt ? "Send “done” again" : "Mark done"}</button><span className={fineClass}>Goes to {agent}.</span></div>}
      {pendingLine}
    </div>}
    {record.kind === "incident" && !state?.dismissedAt && <button type="button" className={`mt-3.5 ${buttonClass}`} disabled={busy} onClick={() => void perform(() => savePrivate({ dismissedAt: new Date().toISOString() }, "incident-read"))}>Mark as read</button>}
    {record.kind === "progress" && !!record.steps.length && <>
      <div role="img" aria-label={`Step ${Math.min(record.currentStep + 1, record.steps.length)} of ${record.steps.length}`} className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground" style={{ width: `${Math.min(100, ((record.currentStep + 1) / record.steps.length) * 100)}%` }} /></div>
      <p className={`mt-2 ${fineClass}`}>Step {Math.min(record.currentStep + 1, record.steps.length)} of {record.steps.length}{record.steps[record.currentStep] && ` · ${record.steps[record.currentStep]!.name}`}</p>
    </>}
    {record.kind === "claim" && <div className="mt-3.5 space-y-3">
      <p aria-live="polite" className="text-sm">{claims.length ? <>You chose to <b className="font-semibold">{claims.at(-1)!.value.choice}</b> this claim.</> : "Not decided yet."}</p>
      {entry.state.card.needsResponse && <>
        <label className="block text-[13px] font-semibold">Note (optional)<textarea aria-label="Claim decision note" maxLength={4000} value={claimNote} onInput={(event) => setClaimNote(event.currentTarget.value)} className={inputClass} /></label>
        {!waiting && <div className="flex flex-wrap gap-2">{(["keep", "remove", "ignore"] as const).map((value) => { const label = value === "keep" ? "Keep claim" : value === "remove" ? "Remove claim" : "Ignore claim"; return <button key={value} type="button" className={`${buttonClass} aria-pressed:bg-muted aria-pressed:shadow-[inset_0_0_0_2px_hsl(var(--foreground))]`} aria-pressed={claims.at(-1)?.value.choice === value} disabled={busy || stale} onClick={() => afterUndo(label, async () => {
          const at = nextClaimDecisionAt(owner, record.id, Date.now());
          await send("sitrep.claim", { choice: value, ...(claimNote.trim() ? { note: claimNote.trim() } : {}), at }, `claim:${value}:${claimNote}`, false, undefined, true);
          setClaimNote("");
        }, true)}>{label}</button>; })}</div>}
        {pendingLine}
        <p className={fineClass}>Goes to {agent}.</p>
      </>}
    </div>}
    {record.kind === "hold" && entry.state.card.needsResponse && <div className="mt-3.5 space-y-2">
      <label className="block text-[13px] font-semibold">Reason (optional)<input aria-label="Hold request reason" value={reason} onInput={(event) => setReason(event.currentTarget.value)} className={inputClass} /></label>
      {record.unblockedBy.map((ref) => <div key={ref} className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm">{ref}{record.clearedRefs?.some((cleared) => cleared.ref === ref) && " · Cleared"}{state?.clears?.some((clear) => clear.ref === ref) && " · Clear requested"}</span>
        <button type="button" className={buttonClass} disabled={busy || waiting || stale || closed || !!record.clearedRefs?.some((cleared) => cleared.ref === ref)} onClick={() => afterUndo("Mark blocker cleared", () => command({ clears: [{ id: id(), ref, at: new Date().toISOString(), ...(reason.trim() ? { reason: reason.trim() } : {}) }] }, `clear:${ref}:${reason}`))}>Mark blocker cleared</button>
      </div>)}
      <button type="button" className={buttonClass} disabled={busy || waiting || stale || closed} onClick={() => afterUndo("Ask to lift the hold", () => command({ lift: { at: new Date().toISOString(), ...(reason.trim() ? { reason: reason.trim() } : {}) } }, `lift:${reason}`))}>Ask to lift the hold</button>
      {pendingLine}
    </div>}

    {expanded && <div className="mt-4 space-y-3">
      {steer && <div className="space-y-1 text-sm"><p>{record.kind === "ask" && <>If you don't choose, {agent} goes ahead with <b className="font-semibold">{optionLabel(record.default) ?? "its plan"}</b>.</>}</p><p className="text-muted-foreground">{steer === "done" ? "It has gone ahead." : steer === "closed-proceeding" ? "The time to choose has passed; it is going ahead." : `You can still choose${record.kind === "ask" && record.decideBy ? ` until ${stamp(record.decideBy)}` : ""}.`}</p>{record.kind === "ask" && record.proceededAt && <p className="text-muted-foreground">Went ahead {stamp(record.proceededAt)}. A new answer can't undo that.</p>}</div>}
      {!!dependencies.length && <div className="text-sm"><p className="font-semibold">Waiting on</p><ul className="mt-1 space-y-1">{dependencies.map((ref) => { const resolved = graph.resolve(ref); return <li key={ref}>{resolved.record ? depTitle(resolved.record) : ref} · {resolved.state}</li>; })}</ul></div>}
      {record.blocks && <p className="text-sm"><strong className="font-semibold">Holds up: </strong>{record.blocks}</p>}
      {record.kind === "incident" && <dl className="space-y-2 text-sm"><div><dt className="font-semibold">Impact · {record.severity ?? "Unrated"}</dt><dd>{record.impact}</dd></div><div><dt className="font-semibold">Started</dt><dd>{stamp(record.startedAt)}{record.resolvedAt && ` · Resolved ${stamp(record.resolvedAt)}`}</dd></div></dl>}
      {record.kind === "work" && <div className="space-y-2 text-sm"><p><strong className="font-semibold">Next: </strong>{record.next ?? "Not reported"}</p>{record.waitsOn && <p><strong className="font-semibold">Waiting on: </strong>{record.waitsOn}</p>}{!!record.askIds.length && <p>Answer its questions on their own cards.</p>}</div>}
      {record.kind === "ship" && <div className="text-sm"><p className="font-semibold">{record.component} · {record.version}</p>{record.prevVersion && <p>Previous: {record.prevVersion}</p>}<p>{record.status} · {stamp(record.at)}</p></div>}
      {record.kind === "order" && <div className="space-y-2 text-sm"><blockquote className="whitespace-pre-wrap border-l border-border pl-4">{record.verbatim}</blockquote><p>{record.source} · {stamp(record.at)}</p>{record.appliesTo && <p>Applies to: {record.appliesTo}</p>}</div>}
      {record.kind === "claim" && <div className="space-y-2 text-sm">
        <p><a href={record.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-[3px]">{record.site}</a> · {record.location} · {record.severity}</p>
        <blockquote className="border-l border-border pl-4">{record.quote}</blockquote><p><strong className="font-semibold">True today: </strong>{record.trueToday}</p>
        <ul>{record.evidence.map((evidence) => <li key={evidence.ref}>{safeUrl(evidence.ref) ? <a href={evidence.ref} target="_blank" rel="noopener noreferrer" className="underline underline-offset-[3px]">{evidence.label}</a> : <span>{evidence.label}: {evidence.ref}</span>}</li>)}</ul>
        {!!record.makeTrue.tc?.length && <p>To make it true: {record.makeTrue.tc.join(", ")}{record.makeTrue.effort && ` · ${record.makeTrue.effort}`}</p>}
        {!!claims.length && <ol aria-label="Your decisions" className="space-y-1">{claims.map((decision) => <li key={decision.sourceKey}>{decision.value.choice === "keep" ? "Keep" : decision.value.choice === "remove" ? "Remove" : "Ignore"} · {stamp(decision.value.at)}{decision.value.note && ` · ${decision.value.note}`}</li>)}</ol>}
      </div>}
      {record.kind === "hold" && <div className="space-y-1 text-sm">
        <p><strong className="font-semibold">On hold: </strong>{record.what}</p><p><strong className="font-semibold">Why: </strong>{record.cause}</p><p><strong className="font-semibold">Ends when: </strong>{record.exit}</p>{record.samWords && <blockquote className="border-l border-border pl-4">{record.samWords}</blockquote>}
        <p className="text-muted-foreground">Released by {record.releasedBy}{record.expectedRelease && ` · Expected ${record.expectedRelease}`} · {record.unblockedByMode === "any" ? "Any blocker can clear it" : "Every blocker must clear"}</p>
        {record.liftedAt && <p>Lifted {stamp(record.liftedAt)} · {record.liftReason}</p>}
      </div>}
      {record.kind === "progress" && <div className="space-y-2 text-sm"><p className="tabular-nums text-muted-foreground">Step {record.currentStep + 1} of {record.steps.length} · {prose(record.ticket)}</p><ol className="list-decimal space-y-1 pl-5">{record.steps.map((step, index) => <li key={`${index}:${step.name}`} aria-current={index === record.currentStep ? "step" : undefined}>{step.name} · {step.state}</li>)}</ol>{record.note && <p>{record.note}</p>}{record.eta && <p>Expected {stamp(record.eta)}</p>}<p className="text-muted-foreground">Updated by {record.updatedBy ?? record.owner} · {stamp(record.updatedAt)}</p></div>}
      {!!record.links.length && <nav aria-label="Card reports and sources" className="flex flex-wrap gap-x-4">{record.links.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" className={`inline-flex min-h-11 items-center break-all text-sm underline underline-offset-[3px] ${focusRing}`}>{linkCaption(link)}</a>)}</nav>}
      {owner.commands?.map((command) => { const handling = entry.responseHandling?.[command.eventId]; return <p key={command.eventId} role="status" className={fineClass}>Request saved{handling?.acknowledgement && ` · ${agent} got it`}{handling?.outcome && ` · ${handling.outcome.phase === "succeeded" ? "done" : handling.outcome.phase}`}</p>; })}
      {!!entry.historicalCommands?.length && <section aria-label="Historical owner commands" className="space-y-2 text-sm">
        <h4 className="text-[13px] font-semibold">Earlier requests</h4>
        {entry.historicalCommands.map((command) => {
          const saved = entry.responses?.some((response) => response.responseId === command.responseId);
          const handling = saved ? entry.responseHandling?.[command.responseId] : undefined;
          return <div key={command.responseId} className="space-y-1"><p>{command.state.doneAt ? "Marked done" : command.state.lift ? "Asked to lift the hold" : "Marked a blocker cleared"} · {stamp(command.state.updatedAt)}{handling?.acknowledgement && ` · ${agent} got it`}{handling?.outcome && ` · ${handling.outcome.phase}`}</p>
            <p className={fineClass}>{saved ? "Saved here." : "From your archive; not sent again."}</p>
          </div>;
        })}
      </section>}
      {!!owner.outboundNotes?.length && <section aria-label="Legacy outbound notes" className="space-y-2 text-sm"><h4 className="text-[13px] font-semibold">Earlier notes</h4>{owner.outboundNotes.filter((note) => note.card.kind === record.kind && note.card.id === record.id).map((note) => <div key={note.responseId} className="space-y-1">
        <p className="whitespace-pre-wrap">{note.text}</p><p className={fineClass}>{note.type === "hold-notice" ? "Hold notice" : "Note"} · {stamp(note.at)}</p>
        {note.recipientKeys.map((recipientKey) => { const receipts = owner.deliveries.filter((receipt) => receipt.responseId === note.responseId && receipt.recipientKey === recipientKey); return <p key={recipientKey} className={fineClass}>{entry.recipientRoute?.recipients.find((recipient) => recipient.recipientKey === recipientKey)?.legacyName ?? "A recipient"}: {receipts.length ? receipts.map((receipt) => receipt.state).join(", ") : "not reported"}</p>; })}
        {note.unresolvedRecipients.map((recipient) => <p key={recipient} className={fineClass}>{recipient} · kept private, not sent</p>)}
      </div>)}</section>}
      {!!owner.unsupportedResponses?.length && <p className={fineClass}>An earlier reply here is kept and isn't counted as an answer.</p>}
    </div>}

    {thread}
    {/* The card's foot, one row: Ask me later, Drop this card (from the page), and Details at the right, which holds
        who posted the card, its wiring, Pin to top and its history. */}
    {!waiting && (projection.request || expanded) && <div className="mt-3 border-t border-border pt-1">
      {/* On an ask, "Drop this card" is an answer: it waits out the undo, then tells the agent to drop the question, so
          the agent hears it (a plain close would only hide the card here). */}
      <CardDetails card={entry.state.card} typed={{ record }} agent={agent} close={record.kind === "ask" && props.close?.kind === "drop" ? { kind: "drop", onTap: () => afterUndo(DROP_LABEL, () => askAnswer("drop", undefined, true), true) } : props.close} actions={props.extra ?? (projection.needsAction && !snoozed && <button type="button" className={footActionClass} disabled={busy} aria-expanded={later} onClick={() => setLater(!later)}>Ask me later</button>)}>
        <FactRows rows={[
          ["Agent", record.from !== agent ? `${record.from} (through ${agent})` : agent],
          ["Agent ID", <code className="block truncate select-all text-xs">{entry.source.agentDid}</code>],
          ["Type", `${kindWord(record.kind)} · ${record.status}${pinned ? ` · Priority (${pinned.reason})` : ""}`],
          ...(typeof entry.state.card.payload?.project === "string" && entry.state.card.payload.project ? [["Project", entry.state.card.payload.project] as [string, ReactNode]] : []),
          ["Reference", <code className="block truncate select-all text-xs">{record.id}</code>],
          ...(reference ? [["Card ID", reference] as FactRow] : []),
          ...sourceRow(entry.state.card.payload),
        ] as FactRow[]} />
        {receipt && <p>{receipt.header ? "Your answer is saved here." : "This answer is from your archive."}</p>}
        {routeReady && <p className="text-[12.5px] leading-[1.4] text-muted-foreground">Messages on this card go to: {destinations.map((recipient) => <span key={recipient.recipientKey} className="block break-all font-mono">{recipient.legacyName} · {recipient.runtimeTarget.agentId}</span>)}</p>}
        {!!state?.notes?.length && <div aria-label="Your private notes" className="space-y-1"><p className={fineClass}>Your private notes. Only you can see them; they aren't sent to the agent.</p>{state.notes.map((note) => <p key={note.id} className="whitespace-pre-wrap">{note.text} <time className={fineClass} dateTime={note.at}>{stamp(note.at)}</time></p>)}</div>}
        {/* Pin to top puts the card first in your list. Only you see it; it is not sent to any agent. */}
        <div><button type="button" className={`${buttonClass} aria-pressed:bg-muted`} disabled={busy} aria-pressed={!!pinned} onClick={() => void perform(() => savePrivate({ priority: { on: !pinned, at: new Date().toISOString() } }, `priority:${!pinned}`))}>{pinned ? "Unpin" : "Pin to top"}</button>
          <p className={fineClass}>Your agents don't see this.</p></div>
        <section aria-label="Card history" className="mt-2"><p className="mb-2 text-xs font-medium text-muted-foreground">History</p><HistoryTimeline items={history} /></section>
        {(error || notice) && <p role={error ? "alert" : "status"}>{error ?? notice}</p>}
      </CardDetails>
    </div>}
    {later && <section aria-label="Ask me later" className="mt-2 space-y-2 pb-2">
      <p className="text-[13px] font-semibold">Ask me again</p>
      <div className="flex flex-wrap gap-2">{snoozePresets(now).slice(0, 3).map((preset) => <button key={preset.id} type="button" className={buttonClass} disabled={busy} onClick={() => void perform(async () => { await source.snooze(entry, preset.until); setLater(false); onOwnerSaved(); onSnoozed?.(preset.until); })}>{preset.label}</button>)}</div>
    </section>}
    {failedAnswer !== null ? <AnswerFailedLine held={!!answerId.current && !!source.holdsAnswer?.(entry, answerId.current)} /> : error && <ErrorLine>{error}</ErrorLine>}{notice && <p role="status" className={`mt-2 ${fineClass}`}>{notice}</p>}
  </div>;
}

/** Why a go, a code or a done step was not written when its undo window ended. */
const APPROVAL_EXPIRED = "This approval expired before it was sent. Nothing was sent.";
const APPROVAL_CLOSED = "This approval closed before it was sent. Nothing was sent.";

function ApprovalActions({ entry: incomingEntry, approval: incomingApproval, source, owner: contextOwner, stale = false, onSaved, onOwnerSaved, onNavigate, showStatus = false, inactive = false }: { entry: HomeFeedEntry; approval: Approval; source: HomeFeedSource; owner: SitrepOwnerData; stale?: boolean; onSaved: Props["onSaved"]; onOwnerSaved: Props["onOwnerSaved"]; onNavigate: Props["onNavigate"]; showStatus?: boolean; inactive?: boolean }) {
  const [binding, setBinding] = useState(() => ({ entry: incomingEntry, approval: incomingApproval }));
  const { entry, approval } = binding;
  const [code, setCode] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const [codeOpen, setCodeOpen] = useState(false);
  // The go, a code or a done step waits out the undo window like any answer. A card replaced meanwhile writes nothing.
  const [notSent, setNotSent] = useState<string>();
  const countdown = usePendingSend({ stale, onRefused: () => setNotSent(APPROVAL_CLOSED) });
  const waiting = !!countdown.pending;
  // The response whose write failed: whether it is still held is read when the line renders.
  const [failedId, setFailedId] = useState<string>();
  const pending = useRef<{ key: string; header: NewFeedResponse; payload: FeedResponsePayload } | undefined>(undefined);
  const engagedOnce = useRef(entry.state.response !== null);
  const key = homeFeedKey(entry); const incomingKey = homeFeedKey(incomingEntry);
  const engaged = engagedOnce.current || busy || waiting || pending.current !== undefined;
  const superseded = key !== incomingKey || entry.currentIssuance === false;
  const own = entry.owner ?? contextOwner;
  const answer = projectSitrepCard(approval, [approval], own, Date.now()).answer;
  // Read on render and again when the undo window ends: the approval can expire while it waits.
  const expiredAt = (at: number) => approval.status === "expired" || Boolean(approval.expiresAt && Date.parse(approval.expiresAt) <= at);
  const expired = expiredAt(Date.now());
  const disabled = busy || waiting || stale || inactive || superseded || expired || approval.status !== "open";
  const visibleForm = entry.state.card.needsResponse && ((!inactive && !answer) || busy || waiting || code.length > 0);

  useEffect(() => {
    if (incomingKey === key || !engaged) setBinding({ entry: incomingEntry, approval: incomingApproval });
  }, [incomingEntry, incomingApproval, incomingKey, key, engaged]);

  useEffect(() => {
    if (!superseded || !engaged) return;
    let alive = true; let running = false; let dirty = false;
    const refresh = async () => {
      if (running) { dirty = true; return; }
      running = true;
      do {
        dirty = false;
        try {
          const snapshot = await source.load(entry);
          const restored = snapshot.focusedEntry;
          const typed = restored && parseSitrepCardPayload(restored.state.card.payload?.sitrep);
          if (!restored || homeFeedKey(restored) !== key || typed?.record.kind !== "approval" || JSON.stringify(typed.record) !== JSON.stringify(approval)) throw new Error("Original approval identity could not be refreshed");
          if (alive) setBinding((current) => homeFeedKey(current.entry) === key ? { ...current, entry: restored } : current);
        } catch { if (alive) setError("This request couldn't be refreshed. What you typed stays with it."); }
      } while (alive && dirty);
      running = false;
    };
    const unsubscribe = source.subscribe(() => { void refresh(); });
    void refresh();
    return () => { alive = false; unsubscribe(); };
  }, [source, key, superseded, engaged]);

  async function openCurrent() {
    setBusy(true); setError(undefined);
    try {
      const snapshot = await source.load();
      const latest = snapshot.entries.find((candidate) => candidate.source.sourceId === entry.source.sourceId && candidate.state.card.cardId === entry.state.card.cardId);
      if (!latest || latest.currentIssuance === false) throw new Error("Current approval is not available");
      onNavigate(latest);
    } catch { setError("The new request couldn't be opened. Try again."); }
    finally { setBusy(false); }
  }
  const validCode = /^\S{4,}$/.test(code) && code.length <= 12000;
  function holdApproval(label: string) {
    if (disabled || (approval.codeExpected && !validCode)) return;
    engagedOnce.current = true;
    setError(undefined); setFailedId(undefined); setNotSent(undefined);
    const issuedAt = approval.issuedAt;
    // The latest render's `submit` runs when the window ends, so it sees what changed while it waited.
    countdown.start(label, () => void submitLatest.current(issuedAt));
  }
  async function submit(issuedAt: string) {
    // The undo window has ended. A request that expired, closed or was re-issued meanwhile is not written; the card says so.
    if (expiredAt(Date.now())) { setNotSent(APPROVAL_EXPIRED); return; }
    if (stale || inactive || superseded || approval.status !== "open" || approval.issuedAt !== issuedAt) { setNotSent(APPROVAL_CLOSED); return; }
    if (busy || (approval.codeExpected && !validCode)) return;
    engagedOnce.current = true;
    setBusy(true); setError(undefined);
    const key = `${approval.issuedAt}:${approval.codeExpected ? code : "done"}`;
    let draft = pending.current?.key === key ? pending.current : undefined;
    try {
      if (!draft) {
        const value: Answer = { askId: approval.id, action: approval.codeExpected ? "code" : "done", text: approval.codeExpected ? code : "", at: new Date().toISOString(), issuedAt: approval.issuedAt };
        const action = validateSitrepAction(approval, "sitrep.answer", value, value.at);
        const card = entry.state.card; const saved = entry.state.response;
        draft = { key, header: { cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, responseId: crypto.randomUUID(), kind: saved ? "followup" : "answer", ...(saved ? { supersedesResponseId: saved.responseId } : {}), text: safeSitrepActionSummary(action), createdAt: value.at }, payload: { type: "sitrep.answer", version: 1, data: jsonValue(value) } };
        pending.current = draft;
      }
      const result = await source.saveResponse(entry, draft.header, draft.payload, { hold: true });
      pending.current = undefined; setCode(""); onSaved(entry, result); onOwnerSaved();
    } catch { if (draft) setFailedId(draft.header.responseId); else setError("Your approval wasn't saved. Try again."); }
    finally { setBusy(false); }
  }
  const submitLatest = useRef(submit);
  submitLatest.current = submit;
  const link = approval.url && safeUrl(approval.url) ? new URL(approval.url) : undefined;
  // The code box waits behind "Got a code? Paste it": reviewing comes first.
  const codeShown = visibleForm && approval.codeExpected && (codeOpen || code.length > 0 || busy);
  const action = visibleForm && !approval.codeExpected;
  // The lab's layout: what kind of request and when, what it allows, its steps and link, then its one action.
  return <div className="mt-3.5 space-y-3 text-sm" onFocusCapture={() => { engagedOnce.current = true; }}>
    {superseded && <div role="status" className="space-y-2 rounded-xl bg-muted px-3 py-2.5"><p>This request was replaced. Use the new one below; a code for this one won't work there.</p><button type="button" className={`${buttonClass} bg-background`} disabled={busy} onClick={() => void openCurrent()}>Open the new request</button></div>}
    {showStatus && <TypedAnswerStatus entry={entry} owner={own} answer={answer} record={approval} />}
    <p>{[approvalWords(approval.approvalType, approval.approvalKind), expired && "Expired", `Issued ${stamp(approval.issuedAt)}`, approval.expiresAt && `Expires ${stamp(approval.expiresAt)}`].filter(Boolean).join(" · ")}</p>
    {approval.permissions && <p><strong className="font-semibold">Permissions: </strong>{approval.permissions}</p>}{approval.profile && <p>Profile: {approval.profile}</p>}{approval.target && <p>Target: {approval.target}</p>}{approval.scope && <p>Scope: {approval.scope}{approval.scopeGrant && " · Whole-scope grant"}</p>}
    {approval.names && <p>Names: {approval.names.join(", ")}</p>}{approval.copiedNames && <p>Already copied: {approval.copiedNames.join(", ")}</p>}{approval.keepNames && <p>Also retained: {approval.keepNames.join(", ")}</p>}{approval.warning && <p className="font-medium text-destructive">{approval.warning}</p>}{approval.nameWhy?.map((entry) => <p key={entry.name}>{entry.name}: {entry.why}</p>)}
    {approval.steps && <ol className="list-decimal space-y-1 pl-5">{approval.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
    {link && <a href={approval.url} target="_blank" rel="noopener noreferrer" onClick={() => { engagedOnce.current = true; }} className="inline-flex min-h-10 items-center gap-1.5 underline underline-offset-2">{/openkey/i.test(link.hostname) ? "Review in OpenKey" : `Review on ${link.hostname}`}<ExternalLinkIcon aria-hidden className="size-4" /></a>}
    {visibleForm && approval.codeExpected && !codeShown && <button type="button" className={quietClass} disabled={disabled} onClick={() => { engagedOnce.current = true; setCodeOpen(true); }}>Got a code? Paste it</button>}
    {codeShown && <label className="block font-medium">Approval code<input aria-label="Approval code" type="password" autoComplete="off" autoFocus={codeOpen && !code} value={code} disabled={disabled} onInput={(event) => { engagedOnce.current = true; setCode(event.currentTarget.value); pending.current = undefined; }} className={inputClass} /><span className={`mt-1 block font-normal ${fineClass}`}>Type the exact code, without spaces. Only {entry.source.label} can read it.</span></label>}
    {!waiting && (action || codeShown) && <div className="flex flex-wrap items-center gap-2">
      {action && <button type="button" disabled={disabled} className={approveClass} onClick={() => holdApproval(approval.approvalType === "go" ? "your go-ahead" : "“done”")}>{busy ? "Saving…" : approval.approvalType === "go" ? "Give the go" : "I've done this step"}</button>}
      {codeShown && <button type="button" disabled={disabled || !validCode} className={approveClass} onClick={() => holdApproval("your code")}>{busy ? "Saving…" : "Save code"}</button>}
    </div>}
    {countdown.pending && <PendingAnswer label={countdown.pending.label} seconds={countdown.pending.seconds} onUndo={countdown.undo}><p>Sending {countdown.pending.label}…</p></PendingAnswer>}
    {notSent && <p role="status">{notSent}</p>}
    {failedId ? <AnswerFailedLine held={!!source.holdsAnswer?.(entry, failedId)} /> : error && <ErrorLine>{error}</ErrorLine>}
  </div>;
}
