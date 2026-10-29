import { useEffect, useId, useRef, useState } from "react";
import type { FeedResponse, FeedResponsePayload, NewFeedMessage, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { cardPriority, claimDecisionHistory, compactStamp, depGraph, depTitle, expiryHint, isClosed, jsonValue, linkCaption, linkify, nextClaimDecisionAt, ownerThreadResponseKey, parseSitrepCardPayload, partSteps, projectSitrepCard, safeSitrepActionSummary, snoozePresets, steerState, stepState, threadOwner, validateSitrepAction, validateState, type Answer, type Approval, type BoardRecord, type SamState, type SitrepMessageDelivery, type SitrepOwnerData, type SitrepProjection, type ThreadMessage, type SitrepHeldNote } from "@tinyboilerplate/core/feed/sitrep";
import { safeUrl } from "./feedData";
import { homeFeedKey } from "./feedIdentity";
import type { HomeFeedEntry, HomeFeedOwnerEvent, HomeFeedSource } from "./feedStoreTypes";
import { HomeCardThread } from "./HomeCardThread";

const buttonClass = "min-h-10 rounded-lg border border-border px-3 text-sm disabled:opacity-50";
const primaryClass = "min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50";
const inputClass = "mt-2 w-full rounded-xl border border-border bg-background p-3 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
function prose(text: string, repo?: string) { return linkify(text, repo).map((part, index) => "href" in part ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className="break-words underline underline-offset-2">{part.label}</a> : part.text); }
function stamp(at: string) { return new Date(at).toLocaleString(); }
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
  onOwnerSaved: () => void;
  onNavigate: (entry: HomeFeedEntry) => void;
}

function TypedAnswerStatus({ entry, owner, answer }: { entry: HomeFeedEntry; owner: SitrepOwnerData; answer?: Answer }) {
  if (!answer) return null;
  const original = owner.answers.find((row) => row.value === answer);
  const responseIds = original ? Object.entries(entry.owner?.responseOrigins ?? owner.responseOrigins ?? {}).flatMap(([responseId, origin]) => origin.sourceKey === original.sourceKey ? [responseId] : []) : [];
  const header = responseIds.length === 1 ? entry.responses?.find((response) => response.kind !== "message" && response.responseId === responseIds[0]) : undefined;
  const receipt = header ? entry.responseHandling?.[header.responseId] : undefined;
  const acknowledgement = receipt?.acknowledgement ?? (header && entry.state.acknowledgement?.responseId === header.responseId ? entry.state.acknowledgement : null);
  const outcome = receipt?.outcome ?? (header && entry.state.outcome?.responseId === header.responseId ? entry.state.outcome : null);
  return <div role="status" className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
    <p className="font-medium">{header ? "Answer saved" : "Historical owner answer"}{acknowledgement && " · Agent received"}{outcome && (outcome.phase === "succeeded" ? " · Completed" : " · Failed")}</p>
    {!header && <p className="text-xs text-muted-foreground">Publisher receipt not reported for this exact historical answer.</p>}
    {answer.action === "code" ? <p>Approval code stored privately for the intended agent. Its value is not shown in history or receipts.</p> : <>{answer.choice && <p>Choice: {answer.choice}</p>}{answer.text && <p className="whitespace-pre-wrap">{answer.text}</p>}{typeof outcome?.detail?.message === "string" && <p>{outcome.detail.message}</p>}</>}
    <time className="text-xs text-muted-foreground" dateTime={answer.at}>{stamp(answer.at)}</time>
  </div>;
}

/** Owns its draft for one complete canonical identity, not a changing list index. */
export function SitrepCard(props: Props) {
  const { entry, record, records, entries, owner, projection, source, now, onSaved, onOwnerSaved } = props;
  const answerGroup = useId();
  const state = projection.state;
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<string>();
  const [privateNote, setPrivateNote] = useState("");
  const [outboundNote, setOutboundNote] = useState("");
  const [reason, setReason] = useState("");
  const [claimNote, setClaimNote] = useState("");
  const [followup, setFollowup] = useState(false);
  const [engaged, setEngaged] = useState(false);
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

  async function perform(work: () => Promise<unknown>): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try { await work(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Home action could not be saved"); return false; }
    finally { busyRef.current = false; setBusy(false); }
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
  async function askAnswer(action: "answer" | "drop" | "accept-default" = "answer", selected = choice) {
    if (record.kind !== "ask") return;
    await send("sitrep.answer", { askId: record.id, action, ...(selected ? { choice: selected } : {}), text, at: new Date().toISOString() }, `ask:${action}:${selected ?? ""}:${text}`);
    setText(""); setChoice(undefined); setFollowup(false); setEngaged(false);
  }
  async function command(patch: Partial<SamState>, key: string) {
    const matching = owner.commands?.filter((event) => patch.doneAt ? !!event.state.doneAt : patch.lift ? !!event.state.lift : patch.clears?.some((request) => event.state.clears?.some((prior) => prior.ref === request.ref))).at(-1);
    const event = matching ?? await savePrivate(patch, key);
    const value = event.state;
    const selectedClear = patch.clears?.[0]?.ref;
    const data = { kind: record.kind, id: record.id, steps: {}, updatedAt: value.updatedAt, ...(patch.doneAt && value.doneAt ? { doneAt: value.doneAt } : {}), ...(patch.lift && value.lift ? { lift: value.lift } : {}), ...(selectedClear ? { clears: value.clears?.filter((request) => request.ref === selectedClear) } : {}) };
    await send("sitrep.state", data, `command:${event.eventId}`, true, event.eventId);
    setNotice("Request saved for the publisher; completion requires its actual outcome.");
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
    setNotice("Message saved for the authenticated publisher. Saved is not received or delivered to every logical recipient.");
  }
  async function holdNote() {
    if (!source.saveHeldNote) throw new Error("This feed source does not provide private held-note storage");
    const intendedRecipient = unresolved.join(" / ") || ownerLabel;
    const key = `${intendedRecipient}:${outboundNote}`;
    const pending = heldPending.current?.key === key ? heldPending.current : { key, note: { eventId: crypto.randomUUID(), at: new Date().toISOString(), text: outboundNote, intendedRecipient } };
    heldPending.current = pending;
    await source.saveHeldNote(entry, pending.note);
    setNotice(`Saved privately, not sent: ${intendedRecipient} is unrouted.`); onOwnerSaved();
  }
  const badge = projection.attention === "expired" ? "Expired" : projection.attention === "closed" ? "Closed" : projection.attention === "snoozed" ? "Snoozed" : projection.needsAction ? "Needs action" : projection.request ? "Waiting on owner" : "Information";
  const graph = depGraph(records);
  const dependencies = "unblockedBy" in record ? record.unblockedBy ?? [] : [];
  const pinned = cardPriority(record, state?.priority);
  const ownerLabel = threadOwner(record);
  const route = entry.recipientRoute;
  const destinations = route?.recipients.flatMap((recipient) => recipient.runtimeTarget ? [{ ...recipient, runtimeTarget: recipient.runtimeTarget }] : []) ?? [];
  const unresolved = [...new Set([...(route?.unresolved ?? []), ...(route?.recipients.filter((recipient) => !recipient.runtimeTarget).map((recipient) => recipient.legacyName) ?? [])])];
  const routeReady = destinations.length > 0;
  const visibleQuestion = entry.state.card.needsResponse && record.kind === "ask" && (!projection.answer || followup || engaged || !!text || !!choice);

  return <div className="mt-4 space-y-4 text-sm" aria-label={`${record.kind} details`}>
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className="rounded-full border border-border px-2 py-1">{badge}</span><span>{record.kind} · {record.status}</span><span>Owner: {record.owner ?? record.from}</span>{pinned && <span>Priority · {pinned.reason}</span>}</div>
    {"context" in record && <div className="space-y-2 rounded-xl bg-muted/30 p-4"><p>{prose(record.context.background, record.repo)}</p>{record.context.whyNow && <p><strong>Why now: </strong>{prose(record.context.whyNow, record.repo)}</p>}{record.context.ifNoAnswer && <p><strong>If no answer: </strong>{prose(record.context.ifNoAnswer, record.repo)}</p>}{!!record.context.known.length && <ul className="list-disc space-y-1 pl-5">{record.context.known.map((known, index) => <li key={index}>{prose(known, record.repo)}</li>)}</ul>}{!!record.context.related.length && <p>Earlier questions: {record.context.related.join(", ")}</p>}</div>}
    {!!record.links.length && <nav aria-label="Card reports and sources" className="flex flex-wrap gap-x-4 gap-y-2">{record.links.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" className="min-h-9 break-all underline underline-offset-2">{linkCaption(link)}</a>)}</nav>}
    {!!dependencies.length && <div><p className="font-medium">Dependencies</p><ul className="mt-1 space-y-1">{dependencies.map((ref) => { const resolved = graph.resolve(ref); return <li key={ref}>{ref} · {resolved.state}{resolved.record && ` · ${depTitle(resolved.record)}`}</li>; })}</ul></div>}
    {record.blocks && <p><strong>Blocks: </strong>{record.blocks}</p>}
    {(record.kind === "ask" || record.kind === "task") && <p className="text-xs text-muted-foreground">{record.deadline && `Deadline ${stamp(record.deadline)} · `}{projection.expiryAt === null ? "No automatic expiry" : projection.expiryAt ? `Legacy expiry ${stamp(new Date(projection.expiryAt).toISOString())}` : ""}{expiryHint(record, now, state) && ` · ${expiryHint(record, now, state)}`}</p>}

    {record.kind === "ask" && <div className="space-y-3">
      {record.mode === "proceeding" && <div className="rounded-xl border border-border p-3"><p>Recommended: {record.options.find((option) => option.id === record.recommend)?.label ?? "None"}</p><p>Default: {record.options.find((option) => option.id === record.default)?.label ?? record.default}</p><p>{steerState(record, now, answers) === "done" ? "Already proceeded" : steerState(record, now, answers) === "closed-proceeding" ? "Decision window closed; owner is proceeding" : "Decision window open"}{record.decideBy && ` · ${stamp(record.decideBy)}`}</p>{record.proceededAt && <p>Proceeded at {stamp(record.proceededAt)}. A new response cannot undo that action.</p>}</div>}
      {record.mode !== "proceeding" && record.recommend && <p>Recommended: {record.options.find((option) => option.id === record.recommend)?.label}</p>}
      <TypedAnswerStatus entry={entry} owner={owner} answer={projection.answer} />
      {entry.state.card.needsResponse && !closed && !visibleQuestion && <button type="button" className={buttonClass} onClick={() => setFollowup(true)}>Add follow-up</button>}
      {!closed && visibleQuestion && <form className="space-y-3" onFocusCapture={() => setEngaged(true)} onSubmit={(event) => { event.preventDefault(); void perform(() => askAnswer()); }}>
        <fieldset disabled={busy} className="space-y-2"><legend className="font-medium">Choose an option</legend>{record.options.map((option) => <label key={option.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3"><input type="radio" name={answerGroup} value={option.id} checked={choice === option.id} onChange={() => setChoice(option.id)} /><span><span className="font-medium">{option.label}</span>{option.detail && <span className="mt-1 block text-muted-foreground">{option.detail}</span>}{option.cost && <span className="mt-1 block text-xs">Cost: {option.cost}</span>}</span></label>)}</fieldset>
        <label className="block font-medium">Your answer<textarea aria-label="Your answer" value={text} disabled={busy} onInput={(event) => setText(event.currentTarget.value)} className={`${inputClass} min-h-24`} /></label>
        <div className="flex flex-wrap gap-2"><button className={primaryClass} disabled={busy || (!choice && !text.trim())}>Save answer</button>{record.mode === "proceeding" && record.default && <button type="button" className={buttonClass} disabled={busy} onClick={() => void perform(() => askAnswer("accept-default", record.default))}>Fine, go ahead</button>}{record.recommend && <button type="button" className={buttonClass} disabled={busy} onClick={() => void perform(() => askAnswer("accept-default", record.recommend))}>Accept recommendation</button>}<button type="button" className={buttonClass} disabled={busy} onClick={() => void perform(() => askAnswer("drop"))}>Drop question</button></div>
      </form>}
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
      <p className="text-xs text-muted-foreground">Completion requests address authenticated publisher {entry.source.label} · {entry.source.agentDid}.</p>
      {entry.state.card.needsResponse && <button type="button" className={buttonClass} disabled={busy || closed} onClick={() => void perform(() => { const at = new Date().toISOString(); return command({ doneAt: at, dismissedAt: at }, "task-done"); })}>{state?.doneAt ? "Ensure completion request is saved" : "Mark task done and tell owner"}</button>}
    </div>}
    {record.kind === "incident" && <dl className="space-y-2"><div><dt className="font-medium">Impact · {record.severity ?? "Unrated"}</dt><dd>{record.impact}</dd></div><div><dt className="font-medium">Started</dt><dd>{stamp(record.startedAt)}{record.resolvedAt && ` · Resolved ${stamp(record.resolvedAt)}`}</dd></div></dl>}
    {record.kind === "incident" && <button type="button" className={buttonClass} disabled={busy || !!state?.dismissedAt} onClick={() => void perform(() => savePrivate({ dismissedAt: new Date().toISOString() }, "incident-read"))}>{state?.dismissedAt ? "Incident acknowledged privately" : "Mark incident acknowledged (private)"}</button>}
    {record.kind === "work" && <div className="space-y-2"><p><strong>Next: </strong>{record.next ?? "Not reported"}</p>{record.waitsOn && <p><strong>Waiting on: </strong>{record.waitsOn}</p>}{!!record.askIds.length && <p>Related questions: {record.askIds.join(", ")}. Respond on their exact cards, not this status update.</p>}{record.standing && <p>Standing loop</p>}</div>}
    {record.kind === "ship" && <div><p className="font-medium">{record.component} · {record.version}</p>{record.prevVersion && <p>Previous: {record.prevVersion}</p>}<p>{record.status} · {stamp(record.at)}</p><p className="text-xs text-muted-foreground">Immutable release history; no human response requested.</p></div>}
    {record.kind === "order" && <div className="space-y-2"><blockquote className="whitespace-pre-wrap border-l-2 border-border pl-4">{record.verbatim}</blockquote><p>{record.source} · {stamp(record.at)}</p>{record.appliesTo && <p>Applies to: {record.appliesTo}</p>}<p className="text-xs text-muted-foreground">Standing instruction history; no human response requested.</p></div>}
    {record.kind === "claim" && <div className="space-y-3">
      <p><a href={record.url} target="_blank" rel="noopener noreferrer" className="underline">{record.site}</a> · {record.location} · {record.severity}</p>
      <blockquote className="border-l-2 border-border pl-4">{record.quote}</blockquote><p><strong>True today: </strong>{record.trueToday}</p>
      <ul>{record.evidence.map((evidence) => <li key={evidence.ref}>{safeUrl(evidence.ref) ? <a href={evidence.ref} target="_blank" rel="noopener noreferrer" className="underline">{evidence.label}</a> : <span>{evidence.label}: {evidence.ref}</span>}</li>)}</ul>
      <p>To make true: {record.makeTrue.tc?.join(", ") || "No issue reported"}{record.makeTrue.effort && ` · ${record.makeTrue.effort}`}</p>
      <p aria-live="polite">{claims.length ? `Current decision: ${claims.at(-1)!.value.choice}` : "Not decided yet"}</p>
      {claims.map((decision) => <p key={decision.sourceKey}>Decision saved: {decision.value.choice} · {stamp(decision.value.at)}{decision.value.note && ` · ${decision.value.note}`}</p>)}
      {entry.state.card.needsResponse && <>
        <p className="text-xs text-muted-foreground">Decision to authenticated publisher {entry.source.label} · {entry.source.agentDid}; logical recipient delivery requires its own receipt.</p>
        <label className="block">Decision note (optional)<textarea aria-label="Claim decision note" maxLength={4000} value={claimNote} onInput={(event) => setClaimNote(event.currentTarget.value)} className={inputClass} /></label>
        <div className="flex flex-wrap gap-2">{(["keep", "remove", "ignore"] as const).map((value) => <button key={value} type="button" className={buttonClass} aria-pressed={claims.at(-1)?.value.choice === value} disabled={busy} onClick={() => void perform(async () => {
          const at = nextClaimDecisionAt(owner, record.id, Date.now());
          await send("sitrep.claim", { choice: value, ...(claimNote.trim() ? { note: claimNote.trim() } : {}), at }, `claim:${value}:${claimNote}`);
          setClaimNote("");
        })}>{value === "keep" ? "Keep claim" : value === "remove" ? "Remove claim" : "Ignore claim"}</button>)}</div>
      </>}
    </div>}
    {record.kind === "hold" && <div className="space-y-3">
      <p><strong>Held: </strong>{record.what}</p><p><strong>Cause: </strong>{record.cause}</p><p><strong>Exit: </strong>{record.exit}</p>{record.samWords && <blockquote>{record.samWords}</blockquote>}
      <p>Released by {record.releasedBy}{record.expectedRelease && ` · Expected ${record.expectedRelease}`} · {record.unblockedByMode === "any" ? "Any blocker may clear it" : "All blockers must clear"}</p>
      {entry.state.card.needsResponse && <label className="block">Request reason (optional)<input aria-label="Hold request reason" value={reason} onInput={(event) => setReason(event.currentTarget.value)} className={inputClass} /></label>}
      {record.unblockedBy.map((ref) => <div key={ref} className="flex flex-wrap items-center gap-2">
        <span>{ref}{record.clearedRefs?.some((cleared) => cleared.ref === ref) && " · Cleared by owner"}{state?.clears?.some((clear) => clear.ref === ref) && " · Clear requested"}</span>
        {entry.state.card.needsResponse && <button type="button" className={buttonClass} disabled={busy || closed || !!record.clearedRefs?.some((cleared) => cleared.ref === ref)} onClick={() => void perform(() => command({ clears: [{ id: id(), ref, at: new Date().toISOString(), ...(reason.trim() ? { reason: reason.trim() } : {}) }] }, `clear:${ref}:${reason}`))}>Mark blocker cleared</button>}
      </div>)}
      {entry.state.card.needsResponse && <button type="button" className={buttonClass} disabled={busy || closed} onClick={() => void perform(() => command({ lift: { at: new Date().toISOString(), ...(reason.trim() ? { reason: reason.trim() } : {}) } }, `lift:${reason}`))}>Request hold lift</button>}
      {record.liftedAt && <p>Lifted {stamp(record.liftedAt)} · {record.liftReason}</p>}
    </div>}
    {record.kind === "progress" && <div className="space-y-3"><p>{prose(record.ticket)} · {record.owner} · {record.currentStep + 1}/{record.steps.length}</p><ol className="list-decimal space-y-2 pl-5">{record.steps.map((step, index) => <li key={`${index}:${step.name}`} aria-current={index === record.currentStep ? "step" : undefined}>{step.name} · {step.state}</li>)}</ol>{record.note && <p>{record.note}</p>}{record.eta && <p>ETA {stamp(record.eta)}</p>}<p className="text-xs text-muted-foreground">Updated by {record.updatedBy ?? record.owner} at {stamp(record.updatedAt)}. Owner and appointed live updaters manage this progress; viewing it does not grant edit authority.</p>{!!record.updaters?.length && <details><summary>Appointed updater identities</summary><ul>{record.updaters.map((updater) => <li key={updater} className="break-all">{updater}</li>)}</ul></details>}</div>}

    <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => setLater(!later)}>Ask me later</button><button type="button" className={buttonClass} disabled={busy} aria-pressed={!!pinned} onClick={() => void perform(() => savePrivate({ priority: { on: !pinned, at: new Date().toISOString() } }, `priority:${!pinned}`))}>{pinned ? "Clear private priority" : "Mark private priority"}</button></div>
    {later && <div className="flex flex-wrap gap-2">{snoozePresets(now).map((preset) => <button key={preset.id} type="button" className={buttonClass} disabled={busy} onClick={() => void perform(async () => { await source.snooze(entry, preset.until); setLater(false); onOwnerSaved(); })}>{preset.label}</button>)}</div>}
    <section className="space-y-2 rounded-xl border border-border p-3" aria-label="Private owner notes">
      <label className="block font-medium">Private note<textarea aria-label="Private note" value={privateNote} onInput={(event) => setPrivateNote(event.currentTarget.value)} className={`${inputClass} min-h-20`} /></label>
      <p className="text-xs text-muted-foreground">Stored only in your owner registry. Not sent to any agent.</p>
      <button type="button" className={buttonClass} disabled={busy || !privateNote.trim()} onClick={() => void perform(async () => { await savePrivate({ notes: [{ id: id(), at: new Date().toISOString(), text: privateNote }] }, `private-note:${privateNote}`); setPrivateNote(""); setNotice("Private note saved; not sent."); })}>Save private note</button>
      {state?.notes?.map((note) => <p key={note.id} className="whitespace-pre-wrap">{note.text} <time className="text-xs text-muted-foreground" dateTime={note.at}>{stamp(note.at)}</time></p>)}
    </section>
    <section className="space-y-2 rounded-xl border border-border p-3" aria-label="Explicit note delivery">
      <label className="block font-medium">Note to owner<textarea aria-label="Note to owner" value={outboundNote} onInput={(event) => setOutboundNote(event.currentTarget.value)} className={`${inputClass} min-h-20`} /></label>
      <p className="text-xs text-muted-foreground">{routeReady ? `To ${destinations.map((recipient) => `${recipient.legacyName} (${recipient.runtimeTarget.agentId})`).join(", ")} via publisher ${entry.source.label}. Only these approved destinations receive this explicit message.` : `${ownerLabel} has no owner-approved recipient mapping. This note remains private and unrouted.`}{unresolved.length ? ` Held privately, not sent: ${unresolved.join(" / ")}.` : ""}</p>
      <button type="button" className={buttonClass} disabled={busy || !outboundNote.trim()} onClick={() => void perform(async () => {
        if (!routeReady || unresolved.length) await holdNote();
        if (routeReady) await sendThread(outboundNote, undefined, true);
        heldPending.current = undefined; setOutboundNote("");
        if (routeReady && unresolved.length) setNotice(`Message saved for ${destinations.map((recipient) => recipient.legacyName).join(" / ")}; ${unresolved.join(" / ")} remains held privately, not sent.`);
      })}>{routeReady ? `Send note to ${destinations.map((recipient) => recipient.legacyName).join(" / ")}${unresolved.length ? `; hold ${unresolved.join(" / ")} privately` : ""}` : "Save unrouted note privately"}</button>
      {owner.heldNotes?.map((note) => <div key={note.eventId} className="space-y-1 rounded-lg bg-muted/30 p-3"><p className="font-medium">Unrouted · {note.intendedRecipient}</p><p className="whitespace-pre-wrap">{note.text}</p><p className="text-xs text-muted-foreground">Owner-only; not sent. {stamp(note.at)}</p><button type="button" className={buttonClass} onClick={() => setOutboundNote(note.text)}>Copy into note composer</button></div>)}
    </section>

    <HomeCardThread entry={entry} record={record} owner={owner} busy={busy} closed={closed} now={now} onSend={(value, resendOf) => perform(() => sendThread(value, resendOf))} />
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
    {(!!answers.length || !!state?.snoozes?.length) && <details className="rounded-xl border border-border p-3"><summary className="cursor-pointer font-medium">Typed card history</summary><ol className="mt-2 space-y-2">{answers.map((answer, index) => <li key={`${answer.at}:${index}`}>{answer.action === "code" ? "Approval code saved privately" : `${answer.action}${answer.choice ? ` · ${answer.choice}` : ""}${answer.text ? ` · ${answer.text}` : ""}`} · {stamp(answer.at)}{record.kind === "approval" && answer.issuedAt && <span> · Issuance {answer.issuedAt}</span>}</li>)}{state?.snoozes?.map((snooze) => <li key={`${snooze.at}:${snooze.until}`}>Snoozed at {stamp(snooze.at)} until {stamp(snooze.until)}</li>)}</ol></details>}
    {!!owner.outboundNotes?.length && <section aria-label="Legacy outbound notes" className="space-y-2 rounded-xl border border-border p-3"><h3 className="font-medium">Legacy explicit owner messages</h3>{owner.outboundNotes.filter((note) => note.card.kind === record.kind && note.card.id === record.id).map((note) => <div key={note.responseId} className="space-y-1">
      <p className="text-xs font-medium">{note.type === "hold-notice" ? "Historical hold notice — not authority to repeat the command" : "Explicit legacy send-note event — not a private Home note"}</p>
      <p className="whitespace-pre-wrap">{note.text}</p><p className="text-xs text-muted-foreground">{stamp(note.at)} · {note.eventKey}</p>
      {note.recipientKeys.map((recipientKey) => { const receipts = owner.deliveries.filter((receipt) => receipt.responseId === note.responseId && receipt.recipientKey === recipientKey); return <p key={recipientKey} className="text-xs">{entry.recipientRoute?.recipients.find((recipient) => recipient.recipientKey === recipientKey)?.legacyName ?? recipientKey}: {receipts.length ? receipts.map((receipt) => `${receipt.state} (${receipt.dispatch})`).join(", ") : "not reported"}</p>; })}
      {note.unresolvedRecipients.map((recipient) => <p key={recipient} className="text-xs">Held / unrouted · {recipient} · owner archive only; not sent</p>)}
    </div>)}</section>}
    {owner.unsupportedResponses?.map((response) => <p key={response.responseId} role="status" className="text-xs text-muted-foreground">{response.reason}. Saved transport record preserved; no question decision inferred.</p>)}
    {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status" className="text-muted-foreground">{notice}</p>}
  </div>;
}

function ApprovalActions({ entry: incomingEntry, approval: incomingApproval, source, owner: contextOwner, onSaved, onOwnerSaved, onNavigate, showStatus = false, inactive = false }: { entry: HomeFeedEntry; approval: Approval; source: HomeFeedSource; owner: SitrepOwnerData; onSaved: Props["onSaved"]; onOwnerSaved: Props["onOwnerSaved"]; onNavigate: Props["onNavigate"]; showStatus?: boolean; inactive?: boolean }) {
  const [binding, setBinding] = useState(() => ({ entry: incomingEntry, approval: incomingApproval }));
  const { entry, approval } = binding;
  const [code, setCode] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Approval could not be saved"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3">
    {superseded && <div role="status" className="rounded-xl border border-border p-3 text-xs"><p>Re-issued. This view and any code draft remain bound to <code className="break-all">{entry.state.card.cardId}/{entry.state.card.revision}/{entry.state.card.issuanceId}</code>. Codes are not transferred to the new request.</p><button type="button" className={buttonClass} disabled={busy} onClick={() => void openCurrent()}>Open current approval</button></div>}
    {showStatus && <TypedAnswerStatus entry={entry} owner={own} answer={answer} />}
    <p>{approval.approvalType}{approval.approvalKind && ` · ${approval.approvalKind}`}{expired && " · Expired"} · Issued {stamp(approval.issuedAt)}{approval.expiresAt && ` · Expires ${stamp(approval.expiresAt)}`}</p>
    {approval.permissions && <p><strong>Permissions: </strong>{approval.permissions}</p>}{approval.profile && <p>Profile: {approval.profile}</p>}{approval.target && <p>Target: {approval.target}</p>}{approval.scope && <p>Scope: {approval.scope}{approval.scopeGrant && " · Whole-scope grant"}</p>}
    {approval.names && <p>Names: {approval.names.join(", ")}</p>}{approval.copiedNames && <p>Already copied: {approval.copiedNames.join(", ")}</p>}{approval.keepNames && <p>Also retained: {approval.keepNames.join(", ")}</p>}{approval.grantMode && <p>Grant mode: {approval.grantMode}</p>}{approval.warning && <p className="font-medium text-destructive">{approval.warning}</p>}{approval.nameWhy?.map((entry) => <p key={entry.name}>{entry.name}: {entry.why}</p>)}
    {approval.steps && <ol className="list-decimal space-y-1 pl-5">{approval.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
    {approval.url && safeUrl(approval.url) && <a href={approval.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center underline underline-offset-2">Open approval · {new URL(approval.url).hostname}</a>}
    {visibleForm && approval.codeExpected && <label className="block font-medium">Approval code<input aria-label="Approval code" type="password" autoComplete="off" value={code} disabled={disabled} onInput={(event) => { engagedOnce.current = true; setCode(event.currentTarget.value); pending.current = undefined; }} className={inputClass} /><span className="mt-1 block text-xs text-muted-foreground">Exact code, without spaces. Stored in the private payload for the intended agent; never the answer text.</span></label>}
    {visibleForm && <button type="button" disabled={disabled || (approval.codeExpected && !validCode)} className={primaryClass} onClick={() => void submit()}>{busy ? "Saving approval…" : approval.approvalType === "go" ? "Give the go" : approval.codeExpected ? "Save code" : "I completed this step"}</button>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
