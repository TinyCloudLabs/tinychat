import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLinkIcon } from "lucide-react";
import type { FeedResponse, FeedResponsePayload, NewFeedMessage, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { cardPriority, claimDecisionHistory, compactStamp, depGraph, depTitle, expiryHint, isClosed, jsonValue, linkCaption, linkify, nextClaimDecisionAt, ownerThreadResponseKey, parseSitrepCardPayload, partSteps, projectSitrepCard, safeSitrepActionSummary, steerState, stepState, threadOwner, validateSitrepAction, validateState, type Answer, type Approval, type BoardRecord, type SamState, type SitrepMessageDelivery, type SitrepOwnerData, type SitrepProjection, type StepState, type ThreadMessage, type SitrepHeldNote } from "@tinyboilerplate/core/feed/sitrep";
import { AnsweredPanel, cardTime, commentCopy, ErrorLine, fieldClass as inputClass, NOT_SENT_COPY, PendingAnswer, usePendingSend, fineClass, focusRing, kindWord, MoreSheet, OptionButtons, optionText, pillClass as buttonClass, primaryPillClass as primaryClass, QuietRow, quietClass, SheetSection, SnoozeChoices } from "./cardKit";
import { safeUrl } from "./feedData";
import { homeFeedKey } from "./feedIdentity";
import type { HomeFeedEntry, HomeFeedOwnerEvent, HomeFeedSource } from "./feedStoreTypes";
import { HomeCardThread } from "./HomeCardThread";

function prose(text: string, repo?: string) { return linkify(text, repo).map((part, index) => "href" in part ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className="break-words underline underline-offset-[3px]">{part.label}</a> : part.text); }
function stamp(at: string) { return cardTime(at, Date.now()); }
function id() { return crypto.randomUUID().replace(/-/g, ""); }
const DAY = 86_400_000;
/** "Request ends in 6 days"; nothing for expiries more than a year out. */
function requestEnds(expiresAt: string | undefined, now: number): string | null {
  const ends = Date.parse(expiresAt ?? "");
  if (!Number.isFinite(ends) || ends - now > 365 * DAY) return null;
  if (ends <= now) return "This request has ended";
  const hours = Math.ceil((ends - now) / 3_600_000);
  if (hours < 24) return `Request ends in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round((ends - now) / DAY);
  return `Request ends in ${days} ${days === 1 ? "day" : "days"}`;
}
const STEP_WORDS: Record<StepState, string> = { pending: "Waiting for you", done: "Done", "not needed": "Not needed", expired: "Ended", closed: "Closed" };
const ANSWER_FAILED = "Your answer wasn't saved. Try again.";

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
  /** The card reference, shown under More → Details. */
  reference?: ReactNode;
  onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void;
  onOwnerSaved: () => void;
  onSnoozed?: (entry: HomeFeedEntry) => void;
  onNavigate: (entry: HomeFeedEntry) => void;
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
    : answer.action === "drop" ? "You dropped this question."
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
  const [noteOpen, setNoteOpen] = useState(false);
  const [tapped, setTapped] = useState<string>();
  const [justSaved, setJustSaved] = useState(false);
  const [more, setMore] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [composing, setComposing] = useState(false);
  const countdown = usePendingSend({ stale, onRefused });
  const [reason, setReason] = useState("");
  const [claimNote, setClaimNote] = useState("");
  const [followup, setFollowup] = useState(false);
  const [later, setLater] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const pending = useRef<{ key: string; header: NewFeedResponse | NewFeedMessage; payload: FeedResponsePayload } | undefined>(undefined);
  const privatePending = useRef<{ key: string; event: HomeFeedOwnerEvent } | undefined>(undefined);
  const heldPending = useRef<{ key: string; note: SitrepHeldNote } | undefined>(undefined);
  const busyRef = useRef(false);
  const closed = isClosed(record);
  const answers = owner.answers.filter((answer) => answer.card.kind === record.kind && answer.card.id === record.id).map((answer) => answer.value);
  const claims = claimDecisionHistory(owner, record.id);

  async function perform(work: () => Promise<unknown>, failure = "That wasn't saved. Try again."): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await work(); return true; }
    catch { setError(failure); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function send(type: string, data: unknown, operationKey: string, message = false, responseId?: string, pageClosing = false) {
    // A replaced issuance is never answered: the owner answers the newer card instead.
    if (stale) throw new Error("This card was replaced by a newer issuance");
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
    } else result = await source.saveResponse(entry, draft.header, draft.payload, { pageClosing });
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
  async function askAnswer(action: "answer" | "drop" | "accept-default" = "answer", selected?: string, pageClosing = false) {
    if (record.kind !== "ask") return;
    await send("sitrep.answer", { askId: record.id, action, ...(selected ? { choice: selected } : {}), text, at: new Date().toISOString() }, `ask:${action}:${selected ?? ""}:${text}`, false, undefined, pageClosing);
    setText(""); setNoteOpen(false); setFollowup(false); setConfirmDrop(false); setMore(false); setJustSaved(true);
  }
  async function tap(action: "answer" | "accept-default", selected: string, pageClosing = false) {
    setTapped(selected);
    await perform(() => askAnswer(action, selected, pageClosing), ANSWER_FAILED);
    setTapped(undefined);
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
  const deadline = (record.kind === "ask" || record.kind === "task") && record.deadline && !closed ? Date.parse(record.deadline) : NaN;
  const hint = expiryHint(record, now, state);
  const receipt = projection.answer && answerReceipt(entry, owner, projection.answer);
  const options = record.kind === "ask" ? record.options.map((option) => ({ id: option.id, label: option.label, detail: [option.detail, option.cost && `Cost: ${option.cost}`].filter(Boolean).join(" · ") || undefined })) : [];
  const steer = record.kind === "ask" && record.mode === "proceeding" ? steerState(record, now, answers) : undefined;
  const optionLabel = (optionId?: string) => { const option = record.kind === "ask" ? record.options.find((candidate) => candidate.id === optionId) : undefined; return option && optionText(option.label); };

  const audience = route ? commentCopy({ approved: destinations.map((recipient) => recipient.legacyName), held: unresolved }) : commentCopy({ approved: [agent] });
  const thread = <HomeCardThread entry={entry} record={record} owner={owner} busy={busy} closed={closed} now={now} open={expanded} composing={composing && !closed} input={audience.input} helper={audience.helper}
    onSend={(value) => perform(() => messageAgent(value))} onResend={(value, resendOf) => perform(() => sendThread(value, resendOf))} onClose={() => setComposing(false)} />;

  return <div className="text-[15px]" aria-label={`${kindWord(record.kind)} details`}>
    {Number.isFinite(deadline) && <p className={`mt-2 text-[13px] tabular-nums ${deadline - now < 86_400_000 ? "font-medium text-warning" : "text-muted-foreground"}`}>{record.kind === "ask" ? "Answer by" : "Due"} {stamp(new Date(deadline).toISOString()).replace(/^Today, /, "today ")}</p>}
    {!Number.isFinite(deadline) && hint && <p className="mt-2 text-[13px] font-medium text-warning">{hint.replace(/^expires/, "Expires")}</p>}

    {record.kind === "ask" && <>
      {countdown.pending && <PendingAnswer label={countdown.pending.label} seconds={countdown.pending.seconds} onUndo={countdown.undo}>
        {countdown.pending.label === NOT_SENT_COPY.yourAnswer ? <p>Sending your answer …</p> : <p>Sending <b className="font-semibold">{countdown.pending.label}</b> …</p>}
      </PendingAnswer>}
      {!countdown.pending && !asking && <TypedAnswerStatus entry={entry} owner={owner} answer={projection.answer} record={record} focusOnMount={justSaved} />}
      {!countdown.pending && asking && followup && <p className="mt-3.5 text-[13px] text-muted-foreground">A new answer replaces your earlier one. It can't undo what {agent} already did.</p>}
      {!countdown.pending && asking && !!options.length && <OptionButtons options={options} suggested={record.recommend} saving={tapped} disabled={busy || stale} onChoose={(choice) => { if (!stale) countdown.start(optionLabel(choice) ?? "", (pageClosing) => void tap("answer", choice, pageClosing)); }} />}
      {!countdown.pending && asking && steer === "open" && record.default && <div className="mt-2 flex flex-wrap items-center gap-x-3"><button type="button" className={buttonClass} disabled={busy || stale} onClick={() => countdown.start(optionLabel(record.default) ?? "its plan", (pageClosing) => void tap("accept-default", record.default!, pageClosing))}>Fine, go ahead</button><span className={fineClass}>{agent} goes ahead with {optionLabel(record.default) ?? "its plan"}{record.decideBy && ` at ${stamp(record.decideBy)}`} unless you choose.</span></div>}
      {!countdown.pending && asking && (noteOpen || !options.length) && <form className="mt-3.5" onSubmit={(event) => { event.preventDefault(); if (!stale && text.trim()) countdown.start(NOT_SENT_COPY.yourAnswer, (pageClosing) => void perform(() => askAnswer("answer", undefined, pageClosing), ANSWER_FAILED)); }}>
        <label className="block"><span className="sr-only">Your answer</span><textarea aria-label="Your answer" value={text} disabled={busy} onInput={(event) => setText(event.currentTarget.value)} className={`${inputClass} min-h-24 resize-y`} /></label>
        <button className={`mt-2 ${buttonClass}`} disabled={busy || stale || !text.trim()}>{busy && !tapped ? "Sending…" : "Send answer"}</button>
      </form>}
      {projection.parts.map((part) => <section key={part.view.approval.id} className="mt-3.5 space-y-3" aria-label="Folded approval step">{partSteps(part).map((step) => {
        const matches = entries.filter((candidate) => { const typed = parseSitrepCardPayload(candidate.state.card.payload?.sitrep); return typed?.record.kind === "approval" && typed.record.id === step.approval.id; });
        const target = matches.length === 1 ? matches[0] : undefined;
        return <div key={step.approval.id} className="space-y-1"><p className="font-semibold">{step.approval.title}</p><p className={fineClass}>{STEP_WORDS[stepState(part, step)]}{part.notNeeded && ` · ${part.notNeeded}`}</p>
          {target ? <ApprovalActions entry={target} approval={step.approval} source={source} owner={owner} now={now} expanded={expanded} onSaved={onSaved} onOwnerSaved={onOwnerSaved} onNavigate={props.onNavigate} showStatus inactive={stepState(part, step) !== "pending"} /> : stepState(part, step) === "pending" && <p role="alert" className="text-sm">This step can't be shown here. Open its own card.</p>}
        </div>;
      })}</section>)}
    </>}

    {record.kind === "approval" && <><TypedAnswerStatus entry={entry} owner={owner} answer={projection.answer} record={record} /><ApprovalActions entry={entry} approval={record} source={source} owner={owner} now={now} expanded={expanded} onSaved={onSaved} onOwnerSaved={onOwnerSaved} onNavigate={props.onNavigate} inactive={projection.attention === "not-needed"} /></>}
    {record.kind === "task" && <div className="mt-3.5 space-y-2">
      <fieldset disabled={busy || closed || !entry.state.card.needsResponse}><legend className="sr-only">{entry.state.card.needsResponse ? "Your steps (private)" : "Steps"}</legend>
        {record.steps.map((step) => <label key={step.id} className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-5 accent-foreground" checked={!!state?.steps[step.id]} onChange={(event) => { const checked = event.currentTarget.checked; void perform(() => savePrivate({ steps: { [step.id]: checked ? new Date().toISOString() : null } }, `tick:${step.id}:${checked}`)); }} /><span className={state?.steps[step.id] ? "text-muted-foreground line-through" : ""}>{step.text}</span></label>)}
      </fieldset>
      {record.chatLink && safeUrl(record.chatLink) && <a href={record.chatLink} target="_blank" rel="noopener noreferrer" className={`inline-flex min-h-11 items-center text-sm underline underline-offset-[3px] ${focusRing}`}>Open task context</a>}
      {entry.state.card.needsResponse && <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><button type="button" className={buttonClass} disabled={busy || closed} onClick={() => void perform(() => { const at = new Date().toISOString(); return command({ doneAt: at, dismissedAt: at }, "task-done"); })}>{state?.doneAt ? "Send “done” again" : "Mark done"}</button><span className={fineClass}>Goes to {agent}.</span></div>}
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
        <div className="flex flex-wrap gap-2">{(["keep", "remove", "ignore"] as const).map((value) => <button key={value} type="button" className={`${buttonClass} aria-pressed:bg-muted aria-pressed:shadow-[inset_0_0_0_2px_hsl(var(--foreground))]`} aria-pressed={claims.at(-1)?.value.choice === value} disabled={busy} onClick={() => void perform(async () => {
          const at = nextClaimDecisionAt(owner, record.id, Date.now());
          await send("sitrep.claim", { choice: value, ...(claimNote.trim() ? { note: claimNote.trim() } : {}), at }, `claim:${value}:${claimNote}`);
          setClaimNote("");
        })}>{value === "keep" ? "Keep claim" : value === "remove" ? "Remove claim" : "Ignore claim"}</button>)}</div>
        <p className={fineClass}>Goes to {agent}.</p>
      </>}
    </div>}
    {record.kind === "hold" && entry.state.card.needsResponse && <div className="mt-3.5 space-y-2">
      <label className="block text-[13px] font-semibold">Reason (optional)<input aria-label="Hold request reason" value={reason} onInput={(event) => setReason(event.currentTarget.value)} className={inputClass} /></label>
      {record.unblockedBy.map((ref) => <div key={ref} className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm">{ref}{record.clearedRefs?.some((cleared) => cleared.ref === ref) && " · Cleared"}{state?.clears?.some((clear) => clear.ref === ref) && " · Clear requested"}</span>
        <button type="button" className={buttonClass} disabled={busy || closed || !!record.clearedRefs?.some((cleared) => cleared.ref === ref)} onClick={() => void perform(() => command({ clears: [{ id: id(), ref, at: new Date().toISOString(), ...(reason.trim() ? { reason: reason.trim() } : {}) }] }, `clear:${ref}:${reason}`))}>Mark blocker cleared</button>
      </div>)}
      <button type="button" className={buttonClass} disabled={busy || closed} onClick={() => void perform(() => command({ lift: { at: new Date().toISOString(), ...(reason.trim() ? { reason: reason.trim() } : {}) } }, `lift:${reason}`))}>Ask to lift the hold</button>
    </div>}

    {expanded && <div className="mt-4 space-y-3">
      {"context" in record && <div className="space-y-2"><p>{prose(record.context.background, record.repo)}</p>{record.context.whyNow && <p><strong className="font-semibold">Why now: </strong>{prose(record.context.whyNow, record.repo)}</p>}{record.context.ifNoAnswer && <p><strong className="font-semibold">If no answer: </strong>{prose(record.context.ifNoAnswer, record.repo)}</p>}{!!record.context.known.length && <ul className="list-disc space-y-1 pl-5">{record.context.known.map((known, index) => <li key={index}>{prose(known, record.repo)}</li>)}</ul>}{!!record.context.related.length && <p>Earlier questions: {record.context.related.join(", ")}</p>}</div>}
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
        <p>To make it true: {record.makeTrue.tc?.join(", ") || "nothing planned yet"}{record.makeTrue.effort && ` · ${record.makeTrue.effort}`}</p>
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
      {(!!answers.length || !!state?.snoozes?.length) && <section aria-label="Card history" className="space-y-1 text-sm"><h4 className="text-[13px] font-semibold">History</h4><ol className="space-y-1">{answers.map((answer, index) => <li key={`${answer.at}:${index}`}>{answer.action === "code" ? "Code saved privately" : answer.action === "drop" ? "Dropped" : answer.action === "done" ? "Done" : `Chose ${optionLabel(answer.choice) ?? (answer.choice ? "an option no longer listed" : "a written answer")}`}{answer.action !== "code" && answer.text ? ` · ${answer.text}` : ""} · {stamp(answer.at)}</li>)}{state?.snoozes?.map((snooze) => <li key={`${snooze.at}:${snooze.until}`}>Asked to see it later · {stamp(snooze.at)}, until {stamp(snooze.until)}</li>)}</ol></section>}
      {!!owner.outboundNotes?.length && <section aria-label="Legacy outbound notes" className="space-y-2 text-sm"><h4 className="text-[13px] font-semibold">Earlier notes</h4>{owner.outboundNotes.filter((note) => note.card.kind === record.kind && note.card.id === record.id).map((note) => <div key={note.responseId} className="space-y-1">
        <p className="whitespace-pre-wrap">{note.text}</p><p className={fineClass}>{note.type === "hold-notice" ? "Hold notice" : "Note"} · {stamp(note.at)}</p>
        {note.recipientKeys.map((recipientKey) => { const receipts = owner.deliveries.filter((receipt) => receipt.responseId === note.responseId && receipt.recipientKey === recipientKey); return <p key={recipientKey} className={fineClass}>{entry.recipientRoute?.recipients.find((recipient) => recipient.recipientKey === recipientKey)?.legacyName ?? "A recipient"}: {receipts.length ? receipts.map((receipt) => receipt.state).join(", ") : "not reported"}</p>; })}
        {note.unresolvedRecipients.map((recipient) => <p key={recipient} className={fineClass}>{recipient} · kept private, not sent</p>)}
      </div>)}</section>}
      {owner.unsupportedResponses?.map((response) => <p key={response.responseId} role="status" className={fineClass}>An earlier reply here can't be shown. It is kept, and isn't counted as an answer.</p>)}
    </div>}

    {thread}
    {!countdown.pending && (projection.request || expanded) && <QuietRow>
      {asking && !!options.length && !noteOpen && <button type="button" className={quietClass} onClick={() => setNoteOpen(true)}>Answer in your own words</button>}
      {record.kind === "ask" && responds && !asking && projection.answer?.action !== "drop" && <button type="button" className={quietClass} onClick={() => { setFollowup(true); setJustSaved(false); }}>Change answer</button>}
      {followup && <button type="button" className={quietClass} disabled={busy} onClick={() => { setFollowup(false); setText(""); setNoteOpen(false); }}>Keep my answer</button>}
      {projection.needsAction && !snoozed && <button type="button" className={quietClass} aria-expanded={later} onClick={() => setLater(!later)}>Ask me later</button>}
      {!closed && !composing && <button type="button" className={quietClass} onClick={() => setComposing(true)}>{audience.button}</button>}
      <button type="button" className={quietClass} onClick={() => setMore(true)}>More</button>
    </QuietRow>}
    {later && <SnoozeChoices now={now} disabled={busy} onPick={(until) => void perform(async () => { await source.snooze(entry, until); setLater(false); onOwnerSaved(); onSnoozed?.(entry); })} />}
    {error && <ErrorLine>{error}</ErrorLine>}{notice && <p role="status" className={`mt-2 ${fineClass}`}>{notice}</p>}

    <MoreSheet open={more} onOpenChange={setMore} title={entry.state.card.title || kindWord(record.kind)}>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`${buttonClass} aria-pressed:bg-muted`} disabled={busy} aria-pressed={!!pinned} onClick={() => void perform(() => savePrivate({ priority: { on: !pinned, at: new Date().toISOString() } }, `priority:${!pinned}`))}>{pinned ? "Clear priority" : "Mark as priority"}</button>
        {record.kind === "ask" && responds && !confirmDrop && <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirmDrop(true)}>Drop question</button>}
      </div>
      {confirmDrop && <div role="group" aria-label="Drop this question?" className="space-y-2 rounded-xl bg-muted px-3 py-2.5 text-sm">
        <p>Drop this question? {agent} stops waiting for your answer.</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={`${buttonClass} bg-background`} disabled={busy} onClick={() => void perform(() => askAnswer("drop"))}>Drop it</button><button type="button" className={quietClass} onClick={() => setConfirmDrop(false)}>Keep it</button></div>
      </div>}
      <SheetSection title="Details">
        <p className="text-sm">{kindWord(record.kind)} · {record.status}{pinned && ` · Priority (${pinned.reason})`}</p>
        {receipt && <p className="text-sm">{receipt.header ? "Your answer is saved here." : "Your answer comes from your archive; this device has no receipt for it."}</p>}
        {routeReady && <p className="text-[12.5px] leading-[1.4] text-muted-foreground">Messages on this card go to: {destinations.map((recipient) => <span key={recipient.recipientKey} className="block break-all font-mono">{recipient.legacyName} · {recipient.runtimeTarget.agentId}</span>)}</p>}
        {!!state?.notes?.length && <div aria-label="Your private notes" className="space-y-1 text-sm"><p className={fineClass}>Your private notes. Only you can see them; they aren't sent to the agent.</p>{state.notes.map((note) => <p key={note.id} className="whitespace-pre-wrap">{note.text} <time className={fineClass} dateTime={note.at}>{stamp(note.at)}</time></p>)}</div>}
        {reference}
      </SheetSection>
      {(error || notice) && <p role={error ? "alert" : "status"} className="text-sm">{error ?? notice}</p>}
    </MoreSheet>
  </div>;
}

function ApprovalActions({ entry: incomingEntry, approval: incomingApproval, source, owner: contextOwner, now, expanded, onSaved, onOwnerSaved, onNavigate, showStatus = false, inactive = false }: { entry: HomeFeedEntry; approval: Approval; source: HomeFeedSource; owner: SitrepOwnerData; now: number; expanded: boolean; onSaved: Props["onSaved"]; onOwnerSaved: Props["onOwnerSaved"]; onNavigate: Props["onNavigate"]; showStatus?: boolean; inactive?: boolean }) {
  const [binding, setBinding] = useState(() => ({ entry: incomingEntry, approval: incomingApproval }));
  const { entry, approval } = binding;
  const [code, setCode] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const [codeOpen, setCodeOpen] = useState(false);
  const pending = useRef<{ key: string; header: NewFeedResponse; payload: FeedResponsePayload } | undefined>(undefined);
  const engagedOnce = useRef(entry.state.response !== null);
  const key = homeFeedKey(entry); const incomingKey = homeFeedKey(incomingEntry);
  const engaged = engagedOnce.current || busy || pending.current !== undefined;
  const superseded = key !== incomingKey || entry.currentIssuance === false;
  const own = entry.owner ?? contextOwner;
  const answer = projectSitrepCard(approval, [approval], own, Date.now()).answer;
  const expired = approval.status === "expired" || Boolean(approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now());
  const disabled = busy || inactive || superseded || expired || approval.status !== "open";
  const visibleForm = entry.state.card.needsResponse && ((!inactive && !answer) || busy || code.length > 0);

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
  async function submit() {
    if (disabled || (approval.codeExpected && !validCode)) return;
    engagedOnce.current = true;
    setBusy(true); setError(undefined);
    try {
      const key = `${approval.issuedAt}:${approval.codeExpected ? code : "done"}`;
      let draft = pending.current?.key === key ? pending.current : undefined;
      if (!draft) {
        const value: Answer = { askId: approval.id, action: approval.codeExpected ? "code" : "done", text: approval.codeExpected ? code : "", at: new Date().toISOString(), issuedAt: approval.issuedAt };
        const action = validateSitrepAction(approval, "sitrep.answer", value, value.at);
        const card = entry.state.card; const saved = entry.state.response;
        draft = { key, header: { cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, responseId: crypto.randomUUID(), kind: saved ? "followup" : "answer", ...(saved ? { supersedesResponseId: saved.responseId } : {}), text: safeSitrepActionSummary(action), createdAt: value.at }, payload: { type: "sitrep.answer", version: 1, data: jsonValue(value) } };
        pending.current = draft;
      }
      const result = await source.saveResponse(entry, draft.header, draft.payload);
      pending.current = undefined; setCode(""); onSaved(entry, result); onOwnerSaved();
    } catch { setError("Your approval wasn't saved. Try again."); }
    finally { setBusy(false); }
  }
  const ends = requestEnds(approval.expiresAt, now);
  const link = approval.url && safeUrl(approval.url) ? new URL(approval.url) : undefined;
  // "Allows …" belongs to permission requests (an OpenKey link or a code), never to a go/no-go.
  const scoped = approval.approvalType !== "go" && (approval.codeExpected || (!!link && /openkey/i.test(link.hostname)));
  // The code box waits behind "Got a code? Paste it": reviewing comes first.
  const codeShown = visibleForm && approval.codeExpected && (codeOpen || code.length > 0 || busy);
  const action = visibleForm && !approval.codeExpected;
  return <div className="mt-3.5 space-y-3" onFocusCapture={() => { engagedOnce.current = true; }}>
    {superseded && <div role="status" className="space-y-2 rounded-xl bg-muted px-3 py-2.5 text-sm"><p>This request was replaced. Use the new one below; a code for this one won't work there.</p><button type="button" className={`${buttonClass} bg-background`} disabled={busy} onClick={() => void openCurrent()}>Open the new request</button></div>}
    {showStatus && <TypedAnswerStatus entry={entry} owner={own} answer={answer} record={approval} />}
    {approval.warning && <p className="text-sm font-medium text-warning">{approval.warning}</p>}
    {!expanded && approval.permissions && scoped && <p className="line-clamp-2 text-sm">Allows {approval.permissions}</p>}
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
      {link && <a href={approval.url} target="_blank" rel="noopener noreferrer" onClick={() => { engagedOnce.current = true; }} className={action ? buttonClass : primaryClass}>{/openkey/i.test(link.hostname) ? "Review in OpenKey" : `Review on ${link.hostname}`}<ExternalLinkIcon aria-hidden className="size-4" /></a>}
      {action && <button type="button" disabled={disabled} className={approval.approvalType === "go" ? primaryClass : buttonClass} onClick={() => void submit()}>{busy ? "Saving…" : approval.approvalType === "go" ? "Give the go" : "I've done this step"}</button>}
      {(ends || expired) && <span className={fineClass}>{expired ? "This request has ended" : ends}</span>}
    </div>
    {visibleForm && approval.codeExpected && !codeShown && <button type="button" className={quietClass} disabled={disabled} onClick={() => { engagedOnce.current = true; setCodeOpen(true); }}>Got a code? Paste it</button>}
    {codeShown && <div className="space-y-2">
      <label className="block text-[13px] font-semibold">Approval code<input aria-label="Approval code" type="password" autoComplete="off" autoFocus={codeOpen && !code} value={code} disabled={disabled} onInput={(event) => { engagedOnce.current = true; setCode(event.currentTarget.value); pending.current = undefined; }} className={inputClass} /><span className={`mt-1 block font-normal ${fineClass}`}>Type the exact code, without spaces. Only {entry.source.label} can read it.</span></label>
      <button type="button" disabled={disabled || !validCode} className={buttonClass} onClick={() => void submit()}>{busy ? "Saving…" : "Save code"}</button>
    </div>}
    {expanded && <div className="space-y-1 text-sm">
      {approval.permissions && <p><strong className="font-semibold">Allows: </strong>{approval.permissions}</p>}{approval.profile && <p>Profile: {approval.profile}</p>}{approval.target && <p>For: {approval.target}</p>}{approval.scope && <p>Scope: {approval.scope}{approval.scopeGrant && " (everything in it)"}</p>}
      {approval.names && <p>Names: {approval.names.join(", ")}</p>}{approval.copiedNames && <p>Already copied: {approval.copiedNames.join(", ")}</p>}{approval.keepNames && <p>Also kept: {approval.keepNames.join(", ")}</p>}{approval.nameWhy?.map((entry) => <p key={entry.name}>{entry.name}: {entry.why}</p>)}
      {approval.steps && <ol className="list-decimal space-y-1 pl-5">{approval.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
      <p className={fineClass}>Asked {stamp(approval.issuedAt)}</p>
    </div>}
    {error && <ErrorLine>{error}</ErrorLine>}
  </div>;
}
