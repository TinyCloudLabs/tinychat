import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { FeedResponse, FeedResponsePayload, NewFeedMessage, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { cardPriority, claimDecisionHistory, depGraph, depTitle, expiryHint, isClosed, jsonValue, linkCaption, linkify, nextClaimDecisionAt, parseSitrepCardPayload, partSteps, projectSitrepCard, safeSitrepActionSummary, snoozePresets, steerState, stepState, validateSitrepAction, validateState, type Answer, type Approval, type BoardRecord, type SamState, type SitrepOwnerData, type SitrepProjection } from "@tinyboilerplate/core/feed/sitrep";
import { AnswerOptions, answerSummary, OWN_OPTION, OwnAnswerBox, sendingLabel, useUndoWindow } from "./AnswerOptions";
import { AnswerSteps, answerHandling } from "./AnswerSteps";
import { cardAuthor, replyRoute, usePostReply } from "./CardReply";
import { safeUrl } from "./feedData";
import { homeFeedKey } from "./feedIdentity";
import type { HomeFeedEntry, HomeFeedOwnerEvent, HomeFeedSource } from "./feedStoreTypes";
import { CardDetails, footActionClass } from "./CardActions";
import { CardConversation, typedConversation } from "./CardConversation";
import { HistoryTimeline } from "./HistoryTimeline";
import { shortTime } from "./ShortTime";

const buttonClass = "min-h-10 rounded-lg border border-border px-3 text-sm disabled:opacity-50";
const primaryClass = "min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50";
const inputClass = "mt-2 w-full rounded-xl border border-border bg-background p-3 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
function prose(text: string, repo?: string) { return linkify(text, repo).map((part, index) => "href" in part ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className="break-words underline underline-offset-2">{part.label}</a> : part.text); }
const stamp = (at: string) => shortTime(at);
function id() { return crypto.randomUUID().replace(/-/g, ""); }

interface Props {
  entry: HomeFeedEntry;
  record: BoardRecord;
  records: BoardRecord[];
  entries: HomeFeedEntry[];
  owner: SitrepOwnerData;
  projection: SitrepProjection;
  source: HomeFeedSource;
  now: number;
  onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void;
  /** An ask was answered: the card folds to this line. */
  onAnswered: (response: FeedResponse, summary: string) => void;
  onOwnerSaved: () => void;
  onNavigate: (entry: HomeFeedEntry) => void;
  /** The card's reference line, kept with the other wiring under Details. */
  reference?: ReactNode;
  /** At the right of the card's foot: the page's "Next card". */
  end?: ReactNode;
  /** In place of Ask me later: "Bring back now" on a snoozed card opened from the Snoozed list. */
  extra?: ReactNode;
  /** After Ask me later: the card has gone until `until`; the page says when it comes back, with Undo. */
  onSnoozed?: (until: string) => void;
}
type AskAnswer = { action: "answer" | "drop" | "accept-default"; choice?: string };

function TypedAnswerStatus({ entry, owner, answer }: { entry: HomeFeedEntry; owner: SitrepOwnerData; answer?: Answer }) {
  if (!answer) return null;
  const original = owner.answers.find((row) => row.value === answer);
  const responseIds = original ? Object.entries(entry.owner?.responseOrigins ?? owner.responseOrigins ?? {}).flatMap(([responseId, origin]) => origin.sourceKey === original.sourceKey ? [responseId] : []) : [];
  const header = responseIds.length === 1 ? entry.responses?.find((response) => response.kind !== "message" && response.responseId === responseIds[0]) : undefined;
  const steps = header ? { sent: header.createdAt, ...answerHandling(entry, header.responseId) } : null;
  return <div role="status" className="space-y-2 rounded-xl border border-border bg-muted/40 p-3 text-sm">
    {steps ? <AnswerSteps {...steps} /> : <><p className="font-medium">Historical owner answer</p><p className="text-xs text-muted-foreground">Publisher receipt not reported for this exact historical answer.</p></>}
    {answer.action === "code" ? <p>Approval code stored privately for the intended agent. Its value is not shown in history or receipts.</p> : <>{answer.choice && <p>Choice: {answer.choice}</p>}{answer.text && <p className="whitespace-pre-wrap">{answer.text}</p>}{typeof steps?.outcome?.detail?.message === "string" && <p>{steps.outcome.detail.message}</p>}</>}
    {!steps && <time className="text-xs text-muted-foreground" dateTime={answer.at}>{stamp(answer.at)}</time>}
  </div>;
}

/** Owns its draft for one complete canonical identity, not a changing list index. */
export function SitrepCard(props: Props) {
  const { entry, record, records, entries, owner, projection, source, now, onSaved, onOwnerSaved } = props;
  const state = projection.state;
  const [text, setText] = useState("");
  const [ownOpen, setOwnOpen] = useState(false);
  const [chosen, setChosen] = useState<AskAnswer>();
  const [selfNote, setSelfNote] = useState("");
  const [reason, setReason] = useState("");
  const [claimNote, setClaimNote] = useState("");
  const [followup, setFollowup] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [later, setLater] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const pending = useRef<{ key: string; header: NewFeedResponse | NewFeedMessage; payload: FeedResponsePayload } | undefined>(undefined);
  const privatePending = useRef<{ key: string; event: HomeFeedOwnerEvent } | undefined>(undefined);
  const busyRef = useRef(false);
  // A tapped command that is not an ask's answer (task done, a claim decision, a blocker clear, a hold lift): it
  // waits out the same undo window, and `run` does the write when the window ends.
  const [held, setHeld] = useState<{ key: string; run: () => Promise<unknown> }>();
  const hold = useUndoWindow(() => {
    if (chosen) void perform(() => askAnswer(chosen));
    else if (held) void perform(held.run).then(() => setHeld(undefined));
  });
  // Every other action on the card waits while an answer can still be undone.
  const busy = saving || hold.seconds !== null;
  const closed = isClosed(record);
  const answers = owner.answers.filter((answer) => answer.card.kind === record.kind && answer.card.id === record.id).map((answer) => answer.value);
  const claims = claimDecisionHistory(owner, record.id);

  async function perform(work: () => Promise<unknown>): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setSaving(true); setError(undefined); setNotice(undefined);
    try { await work(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Home action could not be saved"); return false; }
    finally { busyRef.current = false; setSaving(false); }
  }
  async function send(type: string, data: unknown, operationKey: string, message = false, responseId?: string) {
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
    } else result = await source.saveResponse(entry, draft.header, draft.payload);
    pending.current = undefined;
    onSaved(entry, result);
    onOwnerSaved();
    return result;
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
  async function askAnswer({ action, choice }: AskAnswer) {
    if (record.kind !== "ask") return;
    // An option goes alone; "Your own answer" goes as the words in its box.
    const words = choice ? "" : text;
    const result = await send("sitrep.answer", { askId: record.id, action, ...(choice ? { choice } : {}), text: words, at: new Date().toISOString() }, `ask:${action}:${choice ?? ""}:${words}`);
    setText(""); setChosen(undefined); setOwnOpen(false); setFollowup(false); setEngaged(false);
    props.onAnswered(result, action === "drop" ? "You dropped this question" : answerSummary(record.options.find((option) => option.id === choice)?.label, words.trim()));
  }
  // One tap chooses: the answer waits out the undo window, then is saved with any typed answer.
  function holdAnswer(answer: AskAnswer) {
    if (busy) return;
    setHeld(undefined); setChosen(answer); hold.start();
  }
  function undoAnswer() { hold.undo(); setChosen(undefined); setHeld(undefined); }
  const sendingAs = (action: AskAnswer["action"]) => busy && chosen?.action === action && !chosen.choice ? sendingLabel(hold.seconds, action === "drop" ? "Dropping" : undefined, action === "drop" ? undefined : author) : undefined;
  // A command button taps like an option: it reads "Sending to {agent} in 4s" with Undo beside it, then writes.
  // `run` makes its timestamps when the window ends, so a command is stamped when it is written, not at the tap.
  function heldButton(key: string, label: string, run: () => Promise<unknown>, options: { disabled?: boolean; pressed?: boolean } = {}) {
    const mine = held?.key === key;
    return <Fragment key={key}>
      <button type="button" className={buttonClass} aria-pressed={options.pressed} disabled={busy || options.disabled} onClick={() => { if (busy) return; setChosen(undefined); setHeld({ key, run }); hold.start(); }}>{mine && busy ? sendingLabel(hold.seconds, undefined, author) : label}</button>
      {mine && hold.seconds !== null && <button type="button" className={buttonClass} onClick={undoAnswer}>Undo</button>}
    </Fragment>;
  }
  async function command(patch: Partial<SamState>, key: string) {
    const matching = owner.commands?.filter((event) => patch.doneAt ? !!event.state.doneAt : patch.lift ? !!event.state.lift : patch.clears?.some((request) => event.state.clears?.some((prior) => prior.ref === request.ref))).at(-1);
    const event = matching ?? await savePrivate(patch, key);
    const value = event.state;
    const selectedClear = patch.clears?.[0]?.ref;
    const data = { kind: record.kind, id: record.id, steps: {}, updatedAt: value.updatedAt, ...(patch.doneAt && value.doneAt ? { doneAt: value.doneAt } : {}), ...(patch.lift && value.lift ? { lift: value.lift } : {}), ...(selectedClear ? { clears: value.clears?.filter((request) => request.ref === selectedClear) } : {}) };
    await send("sitrep.state", data, `command:${event.eventId}`, true, event.eventId);
    setNotice(`Sent to ${author}. It is done when ${author} reports so.`);
  }
  const graph = depGraph(records);
  const dependencies = "unblockedBy" in record ? record.unblockedBy ?? [] : [];
  const pinned = cardPriority(record, state?.priority);
  const author = cardAuthor(entry, record).name;
  const route = replyRoute(entry, record, source);
  const postReply = usePostReply(entry, record, source, onSaved);
  const visibleQuestion = entry.state.card.needsResponse && record.kind === "ask" && (!projection.answer || followup || engaged || !!text || !!chosen);

  return <div className="mt-4 space-y-4 text-sm" aria-label={`${record.kind} details`}>
    {pinned && <p className="text-xs text-muted-foreground">Priority · {pinned.reason}</p>}
    {/* A note saved with Ask me later is here when the card comes back. */}
    {!!state?.notes?.length && <section aria-label="Notes to yourself" className="space-y-1 rounded-xl border border-dashed border-border p-3">
      <p className="text-xs font-medium text-muted-foreground">Your {state.notes.length > 1 ? "notes" : "note"} · only you see {state.notes.length > 1 ? "them" : "it"}</p>
      {state.notes.map((note) => <p key={note.id} className="whitespace-pre-wrap break-words">{note.text} <time className="text-xs text-muted-foreground" dateTime={note.at}>{stamp(note.at)}</time></p>)}
    </section>}
    {"context" in record && <div className="space-y-2 rounded-xl bg-muted/30 p-4"><p>{prose(record.context.background, record.repo)}</p>{record.context.whyNow && <p><strong>Why now: </strong>{prose(record.context.whyNow, record.repo)}</p>}{record.context.ifNoAnswer && <p><strong>If no answer: </strong>{prose(record.context.ifNoAnswer, record.repo)}</p>}{!!record.context.known.length && <ul className="list-disc space-y-1 pl-5">{record.context.known.map((known, index) => <li key={index}>{prose(known, record.repo)}</li>)}</ul>}{!!record.context.related.length && <p>Earlier questions: {record.context.related.join(", ")}</p>}</div>}
    {!!record.links.length && <nav aria-label="Card reports and sources" className="flex flex-wrap gap-x-4 gap-y-2">{record.links.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" className="min-h-9 break-all underline underline-offset-2">{linkCaption(link)}</a>)}</nav>}
    {!!dependencies.length && <div><p className="font-medium">Dependencies</p><ul className="mt-1 space-y-1">{dependencies.map((ref) => { const resolved = graph.resolve(ref); return <li key={ref}>{ref} · {resolved.state}{resolved.record && ` · ${depTitle(resolved.record)}`}</li>; })}</ul></div>}
    {record.blocks && <p><strong>Blocks: </strong>{record.blocks}</p>}
    {(record.kind === "ask" || record.kind === "task") && <p className="text-xs text-muted-foreground">{record.deadline && `Deadline ${stamp(record.deadline)} · `}{projection.expiryAt === null ? "No automatic expiry" : projection.expiryAt ? `Legacy expiry ${stamp(new Date(projection.expiryAt).toISOString())}` : ""}{expiryHint(record, now, state) && ` · ${expiryHint(record, now, state)}`}</p>}

    {record.kind === "ask" && <div className="space-y-3">
      {record.mode === "proceeding" && <div className="rounded-xl border border-border p-3"><p>Recommended: {record.options.find((option) => option.id === record.recommend)?.label ?? "None"}</p><p>Default: {record.options.find((option) => option.id === record.default)?.label ?? record.default}</p><p>{steerState(record, now, answers) === "done" ? "Already proceeded" : steerState(record, now, answers) === "closed-proceeding" ? "Decision window closed; owner is proceeding" : "Decision window open"}{record.decideBy && ` · ${stamp(record.decideBy)}`}</p>{record.proceededAt && <p>Proceeded at {stamp(record.proceededAt)}. A new response cannot undo that action.</p>}</div>}
      {record.mode !== "proceeding" && record.recommend && !visibleQuestion && <p>Recommended: {record.options.find((option) => option.id === record.recommend)?.label}</p>}
      <TypedAnswerStatus entry={entry} owner={owner} answer={projection.answer} />
      {entry.state.card.needsResponse && !closed && !visibleQuestion && <button type="button" className={buttonClass} onClick={() => setFollowup(true)}>Add follow-up</button>}
      {!closed && visibleQuestion && <div className="space-y-3" onFocusCapture={() => setEngaged(true)}>
        <AnswerOptions options={record.options} suggested={record.recommend} chosen={chosen?.choice ?? (chosen?.action === "answer" ? OWN_OPTION.id : undefined)} seconds={hold.seconds} sending={saving} onUndo={undoAnswer}
          onChoose={(option) => option.id === OWN_OPTION.id ? setOwnOpen(!ownOpen) : holdAnswer({ action: "answer", choice: option.id })}
          own={{ open: ownOpen, box: <OwnAnswerBox text={text} disabled={busy} onText={setText} onSend={() => { if (text.trim()) holdAnswer({ action: "answer" }); }} /> }} />
        {error && chosen && !busy && <div role="alert" className="text-destructive"><p>{error}</p><button type="button" className="mt-1 min-h-9 underline" onClick={() => void perform(() => askAnswer(chosen))}>Try again</button></div>}
        <div className="flex flex-wrap gap-2">{record.mode === "proceeding" && record.default && <button type="button" className={buttonClass} disabled={busy} onClick={() => holdAnswer({ action: "accept-default", choice: record.default })}>Fine, go ahead</button>}{record.recommend && <button type="button" className={buttonClass} disabled={busy} onClick={() => holdAnswer({ action: "accept-default", choice: record.recommend })}>Accept recommendation</button>}<button type="button" className={buttonClass} disabled={busy} onClick={() => holdAnswer({ action: "drop" })}>{sendingAs("drop") ?? "Drop question"}</button>{hold.seconds !== null && chosen?.action !== "answer" && <button type="button" className={buttonClass} onClick={undoAnswer}>Undo</button>}</div>
      </div>}
      {projection.parts.map((part) => <section key={part.view.approval.id} className="space-y-3 rounded-xl border border-border p-3" aria-label="Folded approval step">{partSteps(part).map((step) => {
        const matches = entries.filter((candidate) => { const typed = parseSitrepCardPayload(candidate.state.card.payload?.sitrep); return typed?.record.kind === "approval" && typed.record.id === step.approval.id; });
        const target = matches.length === 1 ? matches[0] : undefined;
        return <div key={step.approval.id} className="space-y-2"><p className="font-medium">{step.approval.title}</p><p>{stepState(part, step)}{part.notNeeded && ` · ${part.notNeeded}`}</p>
          {target ? <ApprovalActions entry={target} approval={step.approval} source={source} owner={owner} onSaved={onSaved} onOwnerSaved={onOwnerSaved} onNavigate={props.onNavigate} showStatus inactive={stepState(part, step) !== "pending"} /> : stepState(part, step) === "pending" && <p role="alert">Approval reference is unresolved or ambiguous; open its full card identity.</p>}
        </div>;
      })}</section>)}
    </div>}

    {record.kind === "approval" && <><TypedAnswerStatus entry={entry} owner={owner} answer={projection.answer} /><ApprovalActions entry={entry} approval={record} source={source} owner={owner} onSaved={onSaved} onOwnerSaved={onOwnerSaved} onNavigate={props.onNavigate} inactive={projection.attention === "not-needed"} /></>}
    {record.kind === "task" && <div className="space-y-3">
      <fieldset disabled={busy || closed || !entry.state.card.needsResponse} className="space-y-2"><legend className="font-medium">{entry.state.card.needsResponse ? "Your task checks (private)" : "Task checklist (information)"}</legend>
        {record.steps.map((step) => <label key={step.id} className="flex min-h-10 items-center gap-3"><input type="checkbox" checked={!!state?.steps[step.id]} onChange={(event) => { const checked = event.currentTarget.checked; void perform(() => savePrivate({ steps: { [step.id]: checked ? new Date().toISOString() : null } }, `tick:${step.id}:${checked}`)); }} />{step.text}</label>)}
      </fieldset>
      {record.chatLink && safeUrl(record.chatLink) && <a href={record.chatLink} target="_blank" rel="noopener noreferrer" className="underline">Open task context</a>}
      {entry.state.card.needsResponse && <div className="flex flex-wrap gap-2">{heldButton("task-done", state?.doneAt ? "Ensure completion request is saved" : "Mark task done and tell owner", () => { const at = new Date().toISOString(); return command({ doneAt: at, dismissedAt: at }, "task-done"); }, { disabled: closed })}</div>}
    </div>}
    {record.kind === "incident" && <dl className="space-y-2"><div><dt className="font-medium">Impact · {record.severity ?? "Unrated"}</dt><dd>{record.impact}</dd></div><div><dt className="font-medium">Started</dt><dd>{stamp(record.startedAt)}{record.resolvedAt && ` · Resolved ${stamp(record.resolvedAt)}`}</dd></div></dl>}
    {record.kind === "incident" && <button type="button" className={buttonClass} disabled={busy || !!state?.dismissedAt} onClick={() => void perform(() => savePrivate({ dismissedAt: new Date().toISOString() }, "incident-read"))}>{state?.dismissedAt ? "Incident acknowledged privately" : "Mark incident acknowledged (private)"}</button>}
    {record.kind === "work" && <div className="space-y-2"><p><strong>Next: </strong>{record.next ?? "Not reported"}</p>{record.waitsOn && <p><strong>Waiting on: </strong>{record.waitsOn}</p>}{!!record.askIds.length && <p>Related questions: {record.askIds.join(", ")}. Respond on their exact cards, not this status update.</p>}{record.standing && <p>Standing loop</p>}</div>}
    {record.kind === "ship" && <div><p className="font-medium">{record.component} · {record.version}</p>{record.prevVersion && <p>Previous: {record.prevVersion}</p>}<p>{record.status} · {stamp(record.at)}</p><p className="text-xs text-muted-foreground">Release history. Nothing to answer.</p></div>}
    {record.kind === "order" && <div className="space-y-2"><blockquote className="whitespace-pre-wrap border-l-2 border-border pl-4">{record.verbatim}</blockquote><p>{record.source} · {stamp(record.at)}</p>{record.appliesTo && <p>Applies to: {record.appliesTo}</p>}<p className="text-xs text-muted-foreground">Standing instruction history; no human response requested.</p></div>}
    {record.kind === "claim" && <div className="space-y-3">
      <p><a href={record.url} target="_blank" rel="noopener noreferrer" className="underline">{record.site}</a> · {record.location} · {record.severity}</p>
      <blockquote className="border-l-2 border-border pl-4">{record.quote}</blockquote><p><strong>True today: </strong>{record.trueToday}</p>
      <ul>{record.evidence.map((evidence) => <li key={evidence.ref}>{safeUrl(evidence.ref) ? <a href={evidence.ref} target="_blank" rel="noopener noreferrer" className="underline">{evidence.label}</a> : <span>{evidence.label}: {evidence.ref}</span>}</li>)}</ul>
      <p>To make true: {record.makeTrue.tc?.join(", ") || "No issue reported"}{record.makeTrue.effort && ` · ${record.makeTrue.effort}`}</p>
      <p aria-live="polite">{claims.length ? `Current decision: ${claims.at(-1)!.value.choice}` : "Not decided yet"}</p>
      {claims.map((decision) => <p key={decision.sourceKey}>Decision saved: {decision.value.choice} · {stamp(decision.value.at)}{decision.value.note && ` · ${decision.value.note}`}</p>)}
      {entry.state.card.needsResponse && <>
        <label className="block">Decision note (optional)<textarea aria-label="Claim decision note" maxLength={4000} value={claimNote} disabled={busy} onInput={(event) => setClaimNote(event.currentTarget.value)} className={inputClass} /></label>
        <div className="flex flex-wrap gap-2">{(["keep", "remove", "ignore"] as const).map((value) => heldButton(`claim:${value}`, value === "keep" ? "Keep claim" : value === "remove" ? "Remove claim" : "Ignore claim", async () => {
          const at = nextClaimDecisionAt(owner, record.id, Date.now());
          await send("sitrep.claim", { choice: value, ...(claimNote.trim() ? { note: claimNote.trim() } : {}), at }, `claim:${value}:${claimNote}`);
          setClaimNote("");
        }, { pressed: claims.at(-1)?.value.choice === value }))}</div>
      </>}
    </div>}
    {record.kind === "hold" && <div className="space-y-3">
      <p><strong>Held: </strong>{record.what}</p><p><strong>Cause: </strong>{record.cause}</p><p><strong>Exit: </strong>{record.exit}</p>{record.samWords && <blockquote>{record.samWords}</blockquote>}
      <p>Released by {record.releasedBy}{record.expectedRelease && ` · Expected ${record.expectedRelease}`} · {record.unblockedByMode === "any" ? "Any blocker may clear it" : "All blockers must clear"}</p>
      {entry.state.card.needsResponse && <label className="block">Request reason (optional)<input aria-label="Hold request reason" value={reason} disabled={busy} onInput={(event) => setReason(event.currentTarget.value)} className={inputClass} /></label>}
      {record.unblockedBy.map((ref) => <div key={ref} className="flex flex-wrap items-center gap-2">
        <span>{ref}{record.clearedRefs?.some((cleared) => cleared.ref === ref) && " · Cleared by owner"}{state?.clears?.some((clear) => clear.ref === ref) && " · Clear requested"}</span>
        {entry.state.card.needsResponse && heldButton(`clear:${ref}`, "Mark blocker cleared", () => command({ clears: [{ id: id(), ref, at: new Date().toISOString(), ...(reason.trim() ? { reason: reason.trim() } : {}) }] }, `clear:${ref}:${reason}`), { disabled: closed || !!record.clearedRefs?.some((cleared) => cleared.ref === ref) })}
      </div>)}
      {entry.state.card.needsResponse && <div className="flex flex-wrap gap-2">{heldButton("lift", "Request hold lift", () => command({ lift: { at: new Date().toISOString(), ...(reason.trim() ? { reason: reason.trim() } : {}) } }, `lift:${reason}`), { disabled: closed })}</div>}
      {record.liftedAt && <p>Lifted {stamp(record.liftedAt)} · {record.liftReason}</p>}
    </div>}
    {record.kind === "progress" && <div className="space-y-3"><p>{prose(record.ticket)} · {record.owner} · {record.currentStep + 1}/{record.steps.length}</p><ol className="list-decimal space-y-2 pl-5">{record.steps.map((step, index) => <li key={`${index}:${step.name}`} aria-current={index === record.currentStep ? "step" : undefined}>{step.name} · {step.state}</li>)}</ol>{record.note && <p>{record.note}</p>}{record.eta && <p>ETA {stamp(record.eta)}</p>}<p className="text-xs text-muted-foreground">Updated by {record.updatedBy ?? record.owner} at {stamp(record.updatedAt)}. Owner and appointed live updaters manage this progress; viewing it does not grant edit authority.</p>{!!record.updaters?.length && <details><summary>Appointed updater identities</summary><ul>{record.updaters.map((updater) => <li key={updater} className="break-all">{updater}</li>)}</ul></details>}</div>}

    <CardConversation lines={typedConversation(entry, record, owner)} to={route.to} reason={"reason" in route ? route.reason : undefined} disabled={busy} onSend={(value) => postReply(value, "delivery" in route ? route.delivery : undefined)} onResend={(line) => postReply(line.text, "delivery" in route ? route.delivery : undefined, line.id)} />
    {owner.commands?.map((command) => { const handling = entry.responseHandling?.[command.eventId]; return <div key={command.eventId} role="status" className="rounded-xl border border-border p-3 text-xs"><p>Owner command saved{handling?.acknowledgement && " · Publisher received"}{handling?.outcome && ` · Publisher reported ${handling.outcome.phase}`}</p>{!handling && <p>Receipt not reported. Saving again preserves this command identity; it does not prove delivery or repeat its effect.</p>}</div>; })}
    {!!entry.historicalCommands?.length && <section aria-label="Historical owner commands" className="space-y-2 rounded-xl border border-border p-3">
      <h3 className="font-medium">Historical owner commands</h3>
      {entry.historicalCommands.map((command) => {
        const saved = entry.responses?.some((response) => response.responseId === command.responseId);
        const handling = saved ? entry.responseHandling?.[command.responseId] : undefined;
        return <div key={command.responseId} className="space-y-1 text-xs"><p>{command.state.doneAt ? "Task completion" : command.state.lift ? "Hold lift" : "Blocker clear"} · {stamp(command.state.updatedAt)} · {saved ? "Saved transport record" : "Owner archive only; no restored transport record"}{handling?.acknowledgement && " · Publisher received"}{handling?.outcome && ` · Publisher reported ${handling.outcome.phase}`}</p>
          {owner.deliveries.filter((receipt) => receipt.responseId === command.responseId).map((receipt) => <p key={`${receipt.sourceKey}:${receipt.recipientKey}:${receipt.state}`}>{receipt.recipient} · Legacy {receipt.state} · {receipt.routedTo}</p>)}
          <p className="text-muted-foreground">Historical evidence is retained, not permission to repeat the command. Overall publisher handling is not every recipient's delivery receipt.</p>
        </div>;
      })}
    </section>}
    {!!owner.outboundNotes?.length && <details aria-label="Legacy outbound notes" className="space-y-2 rounded-xl border border-border p-3"><summary className="min-h-8 cursor-pointer font-medium">Legacy explicit owner messages</summary>{owner.outboundNotes.filter((note) => note.card.kind === record.kind && note.card.id === record.id).map((note) => <div key={note.responseId} className="space-y-1">
      <p className="text-xs font-medium">{note.type === "hold-notice" ? "Historical hold notice — not authority to repeat the command" : "Explicit legacy send-note event — not a private Home note"}</p>
      <p className="whitespace-pre-wrap">{note.text}</p><p className="text-xs text-muted-foreground">{stamp(note.at)} · {note.eventKey}</p>
      {note.recipientKeys.map((recipientKey) => { const receipts = owner.deliveries.filter((receipt) => receipt.responseId === note.responseId && receipt.recipientKey === recipientKey); return <p key={recipientKey} className="text-xs">{entry.recipientRoute?.recipients.find((recipient) => recipient.recipientKey === recipientKey)?.legacyName ?? recipientKey}: {receipts.length ? receipts.map((receipt) => `${receipt.state} (${receipt.dispatch})`).join(", ") : "not reported"}</p>; })}
      {note.unresolvedRecipients.map((recipient) => <p key={recipient} className="text-xs">Held / unrouted · {recipient} · owner archive only; not sent</p>)}
    </div>)}</details>}
    {owner.unsupportedResponses?.map((response) => <p key={response.responseId} role="status" className="text-xs text-muted-foreground">{response.reason}. Saved transport record preserved; no question decision inferred.</p>)}
    {/* The card's foot, one row (Sam 11-12; design round 6): Ask me later and Details quiet on the left, Next card on
        the right. Details holds who posted it, its history and its wiring. */}
    <div className="border-t border-border pt-2">
      <CardDetails end={props.end} actions={props.extra ?? <button type="button" className={footActionClass} disabled={busy} aria-expanded={later} onClick={() => setLater(!later)}>Ask me later</button>}>
        <dl>{([
          ["Agent", record.from !== entry.source.label ? `${record.from} (through ${entry.source.label})` : entry.source.label],
          ["Agent ID", <code className="block truncate select-all text-xs">{entry.source.agentDid}</code>],
          ["Type", `${record.kind.charAt(0).toUpperCase()}${record.kind.slice(1)} · ${record.status}`],
          ["Reference", <code className="block truncate select-all text-xs">{record.id}</code>],
        ] as [string, ReactNode][]).map(([term, value]) => <div key={term} className="flex items-baseline justify-between gap-4 border-t border-border py-2 first:border-t-0 first:pt-0"><dt className="shrink-0 text-muted-foreground">{term}</dt><dd className="min-w-0 text-right">{value}</dd></div>)}</dl>
        {record.owner && <p>Agent working on this: {record.owner}</p>}
        {"detail" in route && <p>{route.detail}</p>}
        {record.kind === "task" && <p>Marking the task done asks {entry.source.label} to complete it; it is done when the agent reports so.</p>}
        {record.kind === "claim" && <p>A decision goes to {entry.source.label}. Each agent it reaches confirms with its own receipt.</p>}
        {/* Private priority puts the card first in your list. Only you see it; it is not sent to any agent. */}
        <button type="button" className={`${buttonClass} bg-background`} disabled={busy} aria-pressed={!!pinned} onClick={() => void perform(() => savePrivate({ priority: { on: !pinned, at: new Date().toISOString() } }, `priority:${!pinned}`))}>{pinned ? "Clear private priority" : "Mark private priority"}</button>
        {props.reference}
        {/* The card's history as a rail with dots (Sam, 11-12): posted, then what you did, oldest first. */}
        <section aria-label="Card history" className="mt-2"><p className="mb-2 text-xs font-medium text-muted-foreground">History</p>
          <HistoryTimeline items={[
            { key: "posted", at: entry.state.card.createdAt, title: "Posted" },
            ...answers.map((answer, index) => ({ key: `answer:${answer.at}:${index}`, at: answer.at, title: answer.action === "code" ? "Approval code saved privately" : `You chose to ${answer.action.replace(/-/g, " ")}`, ...(answer.choice || answer.text ? { detail: [answer.choice, answer.text].filter(Boolean).join("\n") } : {}) })),
            ...(state?.snoozes ?? []).map((snooze) => ({ key: `snooze:${snooze.at}`, at: snooze.at, title: `Snoozed until ${stamp(snooze.until)}` })),
          ].sort((a, b) => a.at.localeCompare(b.at)).map((item, index, all) => ({ ...item, tone: index === all.length - 1 ? "current" as const : "done" as const }))} />
        </section>
      </CardDetails>
    </div>
    {/* Ask me later's times open under the foot. A note to yourself goes with a reminder: it is saved with the
        time you pick and only you see it. */}
    {later && <section aria-label="Ask me later" className="space-y-3 rounded-xl border border-border p-3">
      <p className="font-medium">Ask me again</p>
      <div className="flex flex-wrap gap-2">{snoozePresets(now).slice(0, 3).map((preset) => <button key={preset.id} type="button" className={buttonClass} disabled={busy} onClick={() => void perform(async () => {
        if (selfNote.trim()) await savePrivate({ notes: [{ id: id(), at: new Date().toISOString(), text: selfNote.trim() }] }, `private-note:${selfNote}`);
        await source.snooze(entry, preset.until); setSelfNote(""); setLater(false); onOwnerSaved(); props.onSnoozed?.(preset.until);
      })}>{preset.label}</button>)}</div>
      <label className="block font-medium">Add a note to yourself<span className="block text-xs font-normal text-muted-foreground">Only you see this. It is not sent to any agent.</span><textarea aria-label="Note to yourself" value={selfNote} disabled={busy} onInput={(event) => setSelfNote(event.currentTarget.value)} className={`${inputClass} min-h-16`} /></label>
    </section>}
    {error && !(chosen && !closed && visibleQuestion) && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status" className="text-muted-foreground">{notice}</p>}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{hold.status}</p>
  </div>;
}

function ApprovalActions({ entry: incomingEntry, approval: incomingApproval, source, owner: contextOwner, onSaved, onOwnerSaved, onNavigate, showStatus = false, inactive = false }: { entry: HomeFeedEntry; approval: Approval; source: HomeFeedSource; owner: SitrepOwnerData; onSaved: Props["onSaved"]; onOwnerSaved: Props["onOwnerSaved"]; onNavigate: Props["onNavigate"]; showStatus?: boolean; inactive?: boolean }) {
  const [binding, setBinding] = useState(() => ({ entry: incomingEntry, approval: incomingApproval }));
  const { entry, approval } = binding;
  const [code, setCode] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  // Why a held go or code was not written when its undo window ended: the approval expired or closed meanwhile.
  const [notSent, setNotSent] = useState<string>();
  const pending = useRef<{ key: string; header: NewFeedResponse; payload: FeedResponsePayload } | undefined>(undefined);
  // The go, a code or "I completed this step" waits out the undo window like any answer, then `submit` writes it.
  const hold = useUndoWindow(() => void submit());
  const waiting = hold.seconds !== null;
  const engagedOnce = useRef(entry.state.response !== null);
  const key = homeFeedKey(entry); const incomingKey = homeFeedKey(incomingEntry);
  const engaged = engagedOnce.current || busy || waiting || pending.current !== undefined;
  const superseded = key !== incomingKey || entry.currentIssuance === false;
  const own = entry.owner ?? contextOwner;
  const answer = projectSitrepCard(approval, [approval], own, Date.now()).answer;
  // Read on render and again when a held answer is written: the approval can expire inside the undo window.
  const expiredAt = (at: number) => approval.status === "expired" || Boolean(approval.expiresAt && Date.parse(approval.expiresAt) <= at);
  const expired = expiredAt(Date.now());
  const disabled = busy || waiting || inactive || superseded || expired || approval.status !== "open";
  const visibleForm = entry.state.card.needsResponse && ((!inactive && !answer) || busy || waiting || code.length > 0);
  const author = cardAuthor(entry, approval).name;

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
        } catch { if (alive) setError("Original approval could not be refreshed; its draft remains bound to its original identity"); }
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
    } catch { setError("Current approval could not be loaded; the original draft has not been transferred"); }
    finally { setBusy(false); }
  }
  const validCode = /^\S{4,}$/.test(code) && code.length <= 12000;
  function holdApproval() {
    if (disabled || (approval.codeExpected && !validCode)) return;
    engagedOnce.current = true;
    setError(undefined); setNotSent(undefined);
    hold.start();
  }
  async function submit() {
    // The undo window has ended. A go that expired or closed while it waited is not written, and the card says so.
    if (expiredAt(Date.now())) { setNotSent("This approval expired before it was sent. Nothing was sent."); return; }
    if (inactive || superseded || approval.status !== "open") { setNotSent("This approval closed before it was sent. Nothing was sent."); return; }
    if (busy || (approval.codeExpected && !validCode)) return;
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Approval could not be saved"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3" onFocusCapture={() => { engagedOnce.current = true; }}>
    {superseded && <div role="status" className="rounded-xl border border-border p-3 text-xs"><p>Re-issued. This view and any code draft remain bound to <code className="break-all">{entry.state.card.cardId}/{entry.state.card.revision}/{entry.state.card.issuanceId}</code>. Codes are not transferred to the new request.</p><button type="button" className={buttonClass} disabled={busy} onClick={() => void openCurrent()}>Open current approval</button></div>}
    {showStatus && <TypedAnswerStatus entry={entry} owner={own} answer={answer} />}
    <p>{approval.approvalType}{approval.approvalKind && ` · ${approval.approvalKind}`}{expired && " · Expired"} · Issued {stamp(approval.issuedAt)}{approval.expiresAt && ` · Expires ${stamp(approval.expiresAt)}`}</p>
    {approval.permissions && <p><strong>Permissions: </strong>{approval.permissions}</p>}{approval.profile && <p>Profile: {approval.profile}</p>}{approval.target && <p>Target: {approval.target}</p>}{approval.scope && <p>Scope: {approval.scope}{approval.scopeGrant && " · Whole-scope grant"}</p>}
    {approval.names && <p>Names: {approval.names.join(", ")}</p>}{approval.copiedNames && <p>Already copied: {approval.copiedNames.join(", ")}</p>}{approval.keepNames && <p>Also retained: {approval.keepNames.join(", ")}</p>}{approval.grantMode && <p>Grant mode: {approval.grantMode}</p>}{approval.warning && <p className="font-medium text-destructive">{approval.warning}</p>}{approval.nameWhy?.map((entry) => <p key={entry.name}>{entry.name}: {entry.why}</p>)}
    {approval.steps && <ol className="list-decimal space-y-1 pl-5">{approval.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
    {approval.url && safeUrl(approval.url) && <a href={approval.url} target="_blank" rel="noopener noreferrer" onClick={() => { engagedOnce.current = true; }} className="inline-flex min-h-10 items-center underline underline-offset-2">Open approval · {new URL(approval.url).hostname}</a>}
    {visibleForm && approval.codeExpected && <label className="block font-medium">Approval code<input aria-label="Approval code" type="password" autoComplete="off" value={code} disabled={disabled} onInput={(event) => { engagedOnce.current = true; setCode(event.currentTarget.value); pending.current = undefined; }} className={inputClass} /><span className="mt-1 block text-xs text-muted-foreground">Exact code, without spaces. Stored in the private payload for the intended agent; never the answer text.</span></label>}
    {visibleForm && <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={disabled || (approval.codeExpected && !validCode)} className={primaryClass} onClick={holdApproval}>{waiting ? sendingLabel(hold.seconds, undefined, author) : busy ? "Saving approval…" : approval.approvalType === "go" ? "Give the go" : approval.codeExpected ? "Save code" : "I completed this step"}</button>
      {waiting && <button type="button" onClick={hold.undo} className="min-h-11 rounded-lg border border-border px-4 text-sm font-medium fine:min-h-10">Undo</button>}
    </div>}
    {notSent && <p role="status" className="text-muted-foreground">{notSent}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{hold.status}</p>
  </div>;
}
