import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import type { FeedResponse, FeedSelector, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { ANSWER_UNDO_HINT, AnswerOptions, answerSummary, sendingLabel, useUndoWindow } from "./AnswerOptions";
import { AnswerSteps, answerHandling } from "./AnswerSteps";
import { AgentConversation, AgentList, agentKey, agentThreads } from "./AgentConversation";
import { agentProfile, AgentMark, PlatformName } from "./AgentMark";
import { cardAuthor, ReplyBox, replyRoute, usePostReply } from "./CardReply";
import { actionClass, CardActions, CardDetails } from "./CardActions";
import { cardStatus } from "./cardStatus";
import { FeedCardView } from "./FeedView";
import { safeUrl, type FeedCard } from "./feedData";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { cardThread, messageRecipient } from "./HomeCardThread";
import { ShortTime, shortTime } from "./ShortTime";
import { SitrepCard } from "./SitrepCard";
import { typedContexts, type TypedCardContext } from "./sitrepProjection";
import { humanFeedReference, homeFeedKey, homeGroupScope } from "./feedIdentity";
import { cardGroup, cardPriority, compareWaiting, DUE_WINDOW_MS, groupCards, groupPriorityFlag, isClosed, orderPriority, partPending, type SitrepProjection } from "@tinyboilerplate/core/feed/sitrep";
import { HOME_EMPTY_BODY, HOME_EMPTY_CHAT, HOME_EMPTY_HOW, HOME_EMPTY_TITLE, NAV_LABEL_HOME } from "@/lib/homeStrings";
import { PATHS } from "@/shell/routes";
import { FEED_SKILL_URL } from "./strings";

function keyOf(entry: HomeFeedEntry): string {
  const card = entry.state.card;
  return JSON.stringify([entry.source.sourceId, card.cardId, card.revision, card.issuanceId]);
}
function needsAttention(entry: HomeFeedEntry, now: number, typed?: SitrepProjection): boolean {
  if (entry.state.card.payload?.sitrep !== undefined || entry.state.card.payload?.sitrepThread !== undefined) return !!typed?.needsAction && !(Date.parse(entry.view.snoozedUntil ?? "") > now);
  return entry.state.card.needsResponse && !entry.state.response && !(Date.parse(entry.view.snoozedUntil ?? "") > now);
}
function compare(a: HomeFeedEntry, b: HomeFeedEntry): number {
  return b.state.card.urgency - a.state.card.urgency || a.state.card.createdAt.localeCompare(b.state.card.createdAt) || keyOf(a).localeCompare(keyOf(b));
}
function projectOf(entry: HomeFeedEntry): string {
  const project = entry.state.card.payload?.project;
  return typeof project === "string" ? project : "";
}
function cardView(entry: HomeFeedEntry, context?: TypedCardContext): FeedCard {
  const card = entry.state.card;
  const payload = card.payload ?? {};
  const render = ["post", "image", "thread", "article", "link"].includes(String(payload.render)) ? payload.render as FeedCard["render"] : "post";
  const source = payload.source;
  const sourceRecord = source && typeof source === "object" ? source as Record<string, unknown> : undefined;
  return {
    key: keyOf(entry), at: card.createdAt, author: cardAuthor(entry, context?.record), render,
    title: card.title, lead: { text: card.body, ...(typeof payload.image === "string" ? { image: payload.image } : {}) },
    ...(Array.isArray(payload.replies) ? { replies: payload.replies.filter((reply): reply is { text: string } => !!reply && typeof reply === "object" && "text" in reply && typeof reply.text === "string") } : {}),
    ...(typeof payload.body === "string" ? { body: payload.body } : {}),
    ...(typeof payload.url === "string" ? { url: payload.url } : {}),
    ...(sourceRecord && typeof sourceRecord.label === "string" ? { source: {
      label: sourceRecord.label,
      ...(safeUrl(sourceRecord.url) ? { url: sourceRecord.url } : {}),
      ...(typeof sourceRecord.ref === "string" ? { ref: sourceRecord.ref } : {}),
    } } : {}),
  };
}
function ReportLink({ entry }: { entry: HomeFeedEntry }) {
  const report = entry.state.card.payload?.report;
  if (!report || typeof report !== "object") return null;
  const { url, label } = report as Record<string, unknown>;
  if (!safeUrl(url)) return null;
  return <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 max-w-full items-center break-all text-sm underline underline-offset-2">{typeof label === "string" ? label : "Full report"}</a>;
}

function CardHistory({ entry }: { entry: HomeFeedEntry }) {
  const responses = entry.responses ?? (entry.state.response ? [entry.state.response] : []);
  const snoozes = entry.viewEvents?.filter((event) => event.kind === "snoozed") ?? [];
  if (!responses.length && !snoozes.length) return null;
  return <details className="mt-4 rounded-xl border border-border p-3 text-sm">
    <summary className="min-h-8 cursor-pointer font-medium">Card history</summary>
    <ol className="mt-2 space-y-3">
      {responses.map((response) => <li key={response.responseId} className="break-words">
        <p className="text-xs text-muted-foreground">{response.kind === "message" ? "Message saved" : response.kind === "followup" ? "Follow-up saved" : "Answer saved"} · <ShortTime at={response.createdAt} /></p>
        {response.choiceId && <p>{entry.state.card.choices?.find((choice) => choice.id === response.choiceId)?.label ?? response.choiceId}</p>}
        {response.text && <p className="whitespace-pre-wrap">{response.text}</p>}
        {response.supersedesResponseId && <p className="text-xs text-muted-foreground">Follows response {response.supersedesResponseId}</p>}
      </li>)}
      {snoozes.map((event) => <li key={`snooze-${event.sequence}`} className="text-xs text-muted-foreground">Snoozed at {shortTime(event.createdAt)}{event.snoozedUntil && ` until ${shortTime(event.snoozedUntil)}`}</li>)}
    </ol>
  </details>;
}
function ResponseStatus({ entry }: { entry: HomeFeedEntry }) {
  const response = entry.state.response;
  if (!response) return null;
  const { acknowledgement, outcome } = answerHandling(entry, response.responseId);
  const detail = outcome?.detail?.message;
  return <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-4 text-sm" role="status" aria-label="Answer status">
    <AnswerSteps sent={response.createdAt} acknowledgement={acknowledgement} outcome={outcome} />
    {response.choiceId && <p>{entry.state.card.choices?.find((choice) => choice.id === response.choiceId)?.label ?? response.choiceId}</p>}
    {response.text && <p className="whitespace-pre-wrap break-words">{response.text}</p>}
    {typeof detail === "string" && <p className="whitespace-pre-wrap break-words">{detail}</p>}
  </div>;
}

interface SentAnswer { key: string; response: FeedResponse; summary: string; open: boolean }
/**
 * What stays of a card once its answer is sent: what was chosen and, while the card is folded away, the
 * answer's steps. It takes focus when it appears, so the result is announced where the card was.
 */
function AnswerFold({ entry, sent, agent, typed, source, onSaved, onToggle }: { entry: HomeFeedEntry; sent: SentAnswer; agent: string; typed?: TypedCardContext; source: HomeFeedSource; onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void; onToggle: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [replying, setReplying] = useState(false);
  useEffect(() => { ref.current?.focus(); }, []);
  const handling = answerHandling(entry, sent.response.responseId);
  const detail = handling.outcome?.detail?.message;
  // The conversation stays one tap away: its latest line, and a reply to the agent that can act.
  const latest = typed ? cardThread(entry, typed.record, typed.owner).at(-1) : undefined;
  const route = typed && replyRoute(entry, typed.record, source);
  const latestHandling = latest?.header && answerHandling(entry, latest.header.responseId);
  return <div ref={ref} role="status" tabIndex={-1} aria-label="Answer sent" className="mb-3 space-y-3 rounded-2xl border border-border bg-card p-4 text-sm text-card-foreground shadow-sm motion-safe:animate-rise-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <div className="flex items-start gap-2">
      <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words"><span className="font-medium">{sent.summary}</span><span className="block text-xs text-muted-foreground">Sent to {agent} · {entry.state.card.title}</span></p>
      <button type="button" aria-expanded={sent.open} onClick={onToggle} className="min-h-10 shrink-0 rounded-lg border border-border px-3 text-sm">{sent.open ? "Hide card" : "Show card"}</button>
    </div>
    {!sent.open && <AnswerSteps sent={sent.response.createdAt} {...handling} agent={agent} />}
    {!sent.open && typeof detail === "string" && <p className="whitespace-pre-wrap break-words">{detail}</p>}
    {!sent.open && latest && typed && <div aria-label="Latest in the conversation" className="space-y-1 rounded-lg bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">{latest.message.side === "sam" ? `You to ${messageRecipient(entry, typed.record, latest.message)}` : latest.message.from} · <ShortTime at={latest.message.at} /></p>
      <p className="line-clamp-3 whitespace-pre-wrap break-words">{latest.message.text}</p>
      {latest.header && latestHandling && <div className="text-xs"><AnswerSteps sent={latest.header.createdAt} {...latestHandling} agent={messageRecipient(entry, typed.record, latest.message)} final={false} /></div>}
    </div>}
    {!sent.open && typed && route?.to && (replying
      ? <FoldReply entry={entry} record={typed.record} source={source} onSaved={onSaved} to={route.to} delivery={route.delivery} />
      : <button type="button" onClick={() => setReplying(true)} className="min-h-10 rounded-lg border border-border px-3 text-sm">Reply to {route.to}</button>)}
  </div>;
}
function FoldReply({ entry, record, source, onSaved, to, delivery }: { entry: HomeFeedEntry; record: TypedCardContext["record"]; source: HomeFeedSource; onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void; to: string; delivery?: Parameters<ReturnType<typeof usePostReply>>[1] }) {
  const post = usePostReply(entry, record, source, onSaved);
  return <ReplyBox to={to} autoFocus onSend={(text) => post(text, delivery)} />;
}

function AnswerForm({ entry, source, onSaved, onAnswered }: { entry: HomeFeedEntry; source: HomeFeedSource; onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void; onAnswered: (response: FeedResponse, summary: string) => void }) {
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState(false);
  const pendingResponse = useRef<NewFeedResponse | null>(null);
  const hold = useUndoWindow(() => void save());
  const saved = entry.state.response;
  const waiting = saving || hold.seconds !== null;
  async function save() {
    if (saving || (!text.trim() && !choice)) return;
    setSaving(true); setError(null);
    const card = entry.state.card;
    // Retain the response identity across a failed/ambiguous write. A retry
    // cannot create a second answer simply because its first response was lost.
    const response = pendingResponse.current ?? {
      responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
      kind: saved ? "followup" as const : "answer" as const,
      ...(choice ? { choiceId: choice } : {}), ...(text.trim() ? { text: text.trim() } : {}),
      ...(saved ? { supersedesResponseId: saved.responseId } : {}), createdAt: new Date().toISOString(),
    };
    pendingResponse.current = response;
    try {
      const result = await source.saveResponse(entry, response);
      onSaved(entry, result);
      onAnswered(result, answerSummary(response.choiceId && (card.choices?.find((option) => option.id === response.choiceId)?.label ?? response.choiceId), response.text));
      pendingResponse.current = null;
      setText(""); setChoice(undefined); setFollowup(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Answer could not be saved");
    } finally { setSaving(false); }
  }
  function editText(value: string) { setText(value); pendingResponse.current = null; }
  // One tap chooses: the option waits out the undo window, then is saved with any typed answer.
  function choose(id: string) {
    if (waiting) return;
    if (id !== choice) pendingResponse.current = null;
    setChoice(id); hold.start();
  }
  function undo() { hold.undo(); setChoice(undefined); pendingResponse.current = null; }
  if (!entry.state.card.needsResponse) return null;
  return <div className="mt-4 space-y-3">
    <ResponseStatus entry={entry} />
    {saved && !followup ? <button type="button" className="min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => setFollowup(true)}>Add follow-up</button> : <form onSubmit={(event) => { event.preventDefault(); if (!waiting && text.trim()) hold.start(); }} className="space-y-3">
      {saved && <p className="text-xs text-muted-foreground">A follow-up does not cancel an action already received by the agent.</p>}
      {!!entry.state.card.choices?.length && <AnswerOptions options={entry.state.card.choices} chosen={choice} seconds={hold.seconds} sending={saving} to={entry.source.label} onChoose={(option) => choose(option.id)} onUndo={undo} />}
      <label className="block text-sm font-medium">Reply to {entry.source.label}<span className="block text-xs font-normal text-muted-foreground">Write instead of choosing, or as well.</span><textarea name="answer" aria-label={`Reply to ${entry.source.label}`} value={text} disabled={waiting} onInput={(event) => editText(event.currentTarget.value)} className="mt-2 min-h-24 w-full resize-y rounded-xl border border-border bg-background p-3 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" /></label>
      <p className="text-xs text-muted-foreground">{ANSWER_UNDO_HINT}</p>
      {error && <div role="alert" className="text-sm text-destructive"><p>{error}</p><button type="button" disabled={waiting} onClick={() => void save()} className="mt-1 min-h-9 underline">Try again</button></div>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={waiting || !text.trim()} className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{waiting && !choice ? sendingLabel(hold.seconds, "Sending", entry.source.label) : saved ? "Send follow-up" : "Send answer"}</button>
        {hold.seconds !== null && !choice && <button type="button" onClick={undo} className="min-h-11 rounded-lg border border-border px-4 text-sm font-medium">Undo</button>}
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{hold.status}</p>
    </form>}
  </div>;
}

function updateSnapshotEntry(snapshot: HomeFeedSnapshot | null, key: string, update: (entry: HomeFeedEntry) => HomeFeedEntry): HomeFeedSnapshot | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    entries: snapshot.entries.map((entry) => keyOf(entry) === key ? update(entry) : entry),
    ...(snapshot.focusedEntry && keyOf(snapshot.focusedEntry) === key ? { focusedEntry: update(snapshot.focusedEntry) } : {}),
    ...(snapshot.relatedEntries ? { relatedEntries: snapshot.relatedEntries.map((entry) => keyOf(entry) === key ? update(entry) : entry) } : {}),
    ...(snapshot.historicalEntries ? { historicalEntries: snapshot.historicalEntries.map((entry) => keyOf(entry) === key ? update(entry) : entry) } : {}),
  };
}

/** `ask`: the tiny bots ask box, shown under the heading when the account has it. */
export function HomeFeedEntries({ source, ask }: { source: HomeFeedSource; ask?: ReactNode }) {
  const [snapshot, setSnapshot] = useState<HomeFeedSnapshot | null>(null);
  const [selector, setSelector] = useState<FeedSelector>("needs-action");
  const [active, setActive] = useState<HomeFeedEntry | null>(null);
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState("");
  const [project, setProject] = useState("");
  const [history, setHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const [viewBusy, setViewBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [sent, setSent] = useState<SentAnswer | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // The agents list ("list") or one agent's conversation (its key), shown instead of the cards.
  const [agentView, setAgentView] = useState<string | null>(null);
  const chosenSelector = useRef(false);
  const hasDefault = useRef(false);
  const refreshRef = useRef<() => void>(() => {});
  const committed = useRef(new Map<string, FeedResponse>());
  const activeRef = useRef<HomeFeedEntry | null>(null);
  const currentSource = useRef(source);
  currentSource.current = source;

  useEffect(() => {
    let alive = true;
    let running = false;
    let dirty = false;
    let loaded = false;
    chosenSelector.current = false; hasDefault.current = false;
    committed.current.clear();
    activeRef.current = null;
    setSnapshot(null); setActive(null); setError(null);
    setExpandedGroups(new Set()); setSent(null); setAgentView(null);
    const refresh = async () => {
      if (running) { dirty = true; return; }
      running = true;
      do {
        dirty = false;
        try {
          const next = await source.load(activeRef.current ?? undefined);
          if (!alive) return;
          const reconcile = (entry: HomeFeedEntry): HomeFeedEntry => {
            const local = committed.current.get(keyOf(entry));
            if (!local) return entry;
            if (entry.state.response && entry.state.response.sequence >= local.sequence) {
              committed.current.delete(keyOf(entry));
              return entry;
            }
            return { ...entry, state: { ...entry.state, response: local, acknowledgement: null, outcome: null } };
          };
          next.entries = next.entries.map(reconcile);
          if (next.focusedEntry) next.focusedEntry = reconcile(next.focusedEntry);
          if (next.relatedEntries) next.relatedEntries = next.relatedEntries.map(reconcile);
          if (next.historicalEntries) next.historicalEntries = next.historicalEntries.map(reconcile);
          loaded = true;
          setSnapshot(next); setClock(Date.now()); setError(next.connectionError ?? null);
          if (!hasDefault.current && !chosenSelector.current) setSelector(next.settings.defaultSelector);
          hasDefault.current = true;
        } catch (cause) {
          if (alive) setError(cause instanceof Error ? cause.message : "Home feed unavailable");
        }
      } while (alive && dirty);
      running = false;
    };
    refreshRef.current = () => { void refresh(); };
    // The device's last copy of the feed shows at once; the network load below
    // replaces it. Subscribing after the local read lets the first live-update
    // connection already cover every agent the copy knows.
    let unsubscribe: (() => void) | undefined;
    void (source.cached?.() ?? Promise.resolve(null)).then((local) => {
      if (!alive || loaded || !local) return;
      setSnapshot(local); setClock(Date.now());
      if (!chosenSelector.current) setSelector(local.settings.defaultSelector);
    }).catch(() => {}).finally(() => {
      if (alive) unsubscribe = source.subscribe(refreshRef.current);
    });
    void refresh();
    return () => { alive = false; unsubscribe?.(); refreshRef.current = () => {}; };
  }, [source]);

  const entries = history ? [...new Map([...(snapshot?.entries ?? []), ...(snapshot?.historicalEntries ?? [])].map((entry) => [keyOf(entry), entry])).values()] : snapshot?.entries ?? [];
  const contextFor = useMemo(() => {
    const current = typedContexts(snapshot?.entries ?? [], snapshot?.sitrep, clock);
    const retained = new Map<string, ReturnType<typeof current>>();
    return (entry: HomeFeedEntry) => {
      const existing = current(entry); if (existing) return existing;
      const key = keyOf(entry); if (retained.has(key)) return retained.get(key);
      const related = (snapshot?.relatedEntries ?? []).filter((candidate) => entry.modelScope !== undefined && candidate.modelScope === entry.modelScope);
      const replacements = new Set([entry, ...related].map((candidate) => JSON.stringify([candidate.source.sourceId, candidate.state.card.cardId])));
      const peers = (snapshot?.entries ?? []).filter((candidate) => !replacements.has(JSON.stringify([candidate.source.sourceId, candidate.state.card.cardId])));
      const context = typedContexts([...peers, ...related, entry], snapshot?.sitrep, clock)(entry);
      retained.set(key, context); return context;
    };
  }, [snapshot, clock]);
  useEffect(() => {
    let next = Infinity;
    const consider = (value: number | undefined | null) => { if (value && value > clock) next = Math.min(next, value); };
    for (const entry of [...entries, ...(snapshot?.relatedEntries ?? []), ...(snapshot?.focusedEntry ? [snapshot.focusedEntry] : [])]) {
      consider(Date.parse(entry.view.snoozedUntil ?? ""));
      const typed = contextFor(entry) ?? typedContexts([entry], undefined, clock)(entry);
      if (!typed) continue;
      consider(typed.projection.expiryAt);
      if (typed.record.kind === "approval") consider(Date.parse(typed.record.expiresAt ?? ""));
      if (typed.record.kind === "ask") consider(Date.parse(typed.record.decideBy ?? ""));
      if ("deadline" in typed.record && typed.record.deadline) {
        const deadline = Date.parse(typed.record.deadline);
        consider(deadline); consider(deadline - DUE_WINDOW_MS);
      }
    }
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(Math.max(0, next - Date.now() + 1), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [snapshot, clock, contextFor]);
  const matchesFilters = (entry: HomeFeedEntry) => (!agent || entry.source.sourceId === agent) && (!kind || entry.state.card.kind === kind) && (!project || projectOf(entry) === project);
  const matching = entries.filter((entry) => {
    const card = entry.state.card;
    if (!matchesFilters(entry)) return false;
    if (history) return entry.state.card.payload?.sitrepThread !== undefined || !!entry.responses?.length || !!entry.state.response || !!entry.viewEvents?.some((event) => event.kind === "snoozed") || !!entry.owner?.answers.length || !!entry.owner?.claimDecisions.length || !!entry.owner?.threads.length || !!entry.owner?.outboundNotes?.length || !!entry.owner?.heldNotes?.length || !!entry.historicalCommands?.length || !!entry.owner?.states.some((state) => state.notes?.length || state.snoozes?.length || state.doneAt || state.dismissedAt || Object.keys(state.steps).length) || Date.parse(entry.view.snoozedUntil ?? "") > clock;
    const typed = contextFor(entry);
    const unsupported = card.payload?.sitrep !== undefined || card.payload?.sitrepThread !== undefined;
    if (selector === "needs-action" && typed?.projection.foldedInto) {
      const parent = typed.entries.find((candidate) => { const context = contextFor(candidate); return context?.record.kind === "ask" && context.record.id === typed.projection.foldedInto?.id; });
      if (parent && matchesFilters(parent) && needsAttention(parent, clock, contextFor(parent)?.projection)) return false;
    }
    return selector === "both" || (selector === "information" ? typed ? !typed.projection.request : unsupported || !card.needsResponse : needsAttention(entry, clock, typed?.projection));
  }).sort((a, b) => { const first = contextFor(a)?.waiting; const second = contextFor(b)?.waiting; return first && second ? compareWaiting(first, second) || compare(a, b) : compare(a, b); });
  const grouped = groupCards(matching, (entry) => {
    const record = contextFor(entry)?.record;
    const group = record && cardGroup(record);
    return group ? JSON.stringify([homeGroupScope(entry.source.sourceId, entry.modelScope), group]) : undefined;
  }, (entry) => { const record = contextFor(entry)?.record; return !!record && !isClosed(record); });
  const priority = orderPriority(grouped.map((row) => {
    const members = row.kind === "card" ? [row.item] : row.items;
    const pinned = members.map((entry) => { const context = contextFor(entry); return !!context && !!cardPriority(context.record, context.projection.state?.priority); });
    const first = members[0]; const firstRecord = first && contextFor(first)?.record; const group = firstRecord && cardGroup(firstRecord);
    const flagged = row.kind === "group" && group && first ? groupPriorityFlag(contextFor(first)?.owner.groupPriority?.groups[group], pinned) : pinned.some(Boolean);
    return { value: row, flagged, blocker: members.some((entry) => { const context = contextFor(entry); return !!context && (!!context.record.blocks || !!context.waiting?.unblockWeight); }) };
  }));
  const navigation = [...priority.priority, ...priority.rest];
  const filtered = navigation.flatMap((row) => row.kind === "card" ? [row.item] : row.items);
  const activeKey = active ? keyOf(active) : null;
  const selected = entries.find((entry) => keyOf(entry) === activeKey)
    ?? (snapshot?.focusedEntry && keyOf(snapshot.focusedEntry) === activeKey ? snapshot.focusedEntry : active);
  const focused = selected ?? filtered[0];
  const focusedKey = focused ? keyOf(focused) : null;
  const focusedContext = focused ? contextFor(focused) : undefined;
  const focusedUnsupported = !!focused && (focused.state.card.payload?.sitrep !== undefined || focused.state.card.payload?.sitrepThread !== undefined) && !focusedContext;
  activeRef.current = focused ?? null;
  // The card whose answer was just sent folds to a line with its steps, unless it still needs the owner. Until
  // a load confirms the answer the card cannot say so itself, and only an ask's approval steps can still be open.
  const settling = !!sent && committed.current.has(sent.key);
  const fold = sent && focused && sent.key === focusedKey && !(settling ? focusedContext?.projection.parts.some(partPending) : needsAttention(focused, clock, focusedContext?.projection)) ? sent : null;
  const onAnswered = (response: FeedResponse, summary: string) => setSent({ key: focusedKey!, response, summary, open: false });
  const reference = focused && <p className="text-xs text-muted-foreground" aria-label="Card reference"><code className="select-all break-all" title={homeFeedKey(focused)}>{humanFeedReference(focused, entries)}</code></p>;
  const focusedAuthor = focused ? cardAuthor(focused, focusedContext?.record).name : "";
  // Everything between the person and each agent, from every card the page has loaded.
  const agents = agentView ? agentThreads([...new Map([...(snapshot?.entries ?? []), ...(snapshot?.historicalEntries ?? [])].map((entry) => [keyOf(entry), entry])).values()], contextFor, source, (entry) => needsAttention(entry, clock, contextFor(entry)?.projection)) : [];
  const openAgent = agentView && agentView !== "list" ? agents.find((agent) => agent.key === agentView) : undefined;
  // The list under the open card: every other card in this view, in the page's order and groups, under two plain
  // headings, the cards that need the person and the rest. A group keeps all its cards, the open one marked.
  const listed = navigation.filter((row) => row.kind === "group" || keyOf(row.item) !== focusedKey);
  const rowNeedsYou = (row: (typeof listed)[number]) => (row.kind === "card" ? [row.item] : row.items).some((entry) => needsAttention(entry, clock, contextFor(entry)?.projection));
  const sections: [string, typeof listed][] = [
    [focused && needsAttention(focused, clock, focusedContext?.projection) ? "Also needs you" : "Needs you", listed.filter(rowNeedsYou)],
    ["Updates", listed.filter((row) => !rowNeedsYou(row))],
  ];
  const focusedIndex = filtered.findIndex((entry) => keyOf(entry) === focusedKey);
  const nextEntry = filtered.length ? filtered[(focusedIndex + 1) % filtered.length] : undefined;
  useEffect(() => { if (focused && activeKey !== focusedKey) setActive(focused); }, [focusedKey, activeKey]);
  const nextCard = nextEntry && keyOf(nextEntry) !== focusedKey ? <button type="button" onClick={() => setActive(nextEntry)} className={actionClass}>Next card</button> : null;
  useEffect(() => {
    if (!focused || focused.view.seenAt) return;
    let alive = true;
    void source.markSeen(focused).then(() => {
      if (!alive) return;
      const seenAt = new Date().toISOString();
      const update = (entry: HomeFeedEntry): HomeFeedEntry => ({ ...entry, view: { ...entry.view, seenAt } });
      setSnapshot((current) => updateSnapshotEntry(current, focusedKey!, update));
      setActive((current) => current && keyOf(current) === focusedKey ? update(current) : current);
    }).catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : "Could not mark card seen"); });
    return () => { alive = false; };
  }, [source, focusedKey]);

  const onSaved = useCallback((entry: HomeFeedEntry, response: FeedResponse) => {
    if (currentSource.current !== source) return;
    if (response.kind === "message") { refreshRef.current(); return; }
    committed.current.set(keyOf(entry), response);
    const key = keyOf(entry);
    const update = (candidate: HomeFeedEntry): HomeFeedEntry => ({ ...candidate, state: { ...candidate.state, response, acknowledgement: null, outcome: null } });
    setSnapshot((current) => updateSnapshotEntry(current, key, update));
    setActive((current) => current && keyOf(current) === key ? update(current) : current);
    refreshRef.current();
  }, [source]);
  function changeSelector(value: FeedSelector) { chosenSelector.current = true; setSelector(value); setHistory(false); setActive(null); }
  async function saveDefault() {
    setSavingDefault(true); setError(null);
    try {
      await source.setDefaultSelector(selector);
      setSnapshot((current) => current ? { ...current, settings: { defaultSelector: selector } } : current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Default could not be saved"); }
    finally { setSavingDefault(false); }
  }
  async function snooze() {
    if (!focused || viewBusy) return;
    setViewBusy(true); setError(null);
    try {
      const until = new Date(Date.now() + 60 * 60_000).toISOString();
      await source.snooze(focused, until);
      setSnapshot((current) => updateSnapshotEntry(current, focusedKey!, (entry) => ({ ...entry, view: { ...entry.view, snoozedUntil: until } })));
      setActive(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Card could not be snoozed"); }
    finally { setViewBusy(false); }
  }

  // A row in the list under the open card: the agent's mark, the title on one line, and under it who sent it, on
  // which platform, and where the card stands when that is not already the heading.
  function navigationCard(entry: HomeFeedEntry) {
    const context = contextFor(entry);
    const author = cardAuthor(entry, context?.record).name;
    const platform = agentProfile(entry.state.card.payload)?.platform;
    const status = cardStatus(entry, context?.projection, clock, author);
    return <button type="button" aria-current={focusedKey === keyOf(entry) ? "true" : undefined} onClick={() => setActive(entry)} className="flex min-h-14 w-full min-w-0 items-center gap-3 px-1 py-2 text-left text-sm active:bg-muted aria-[current=true]:bg-selected">
      <AgentMark agentKey={agentKey(entry, context?.record)} name={author} small />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{entry.state.card.title}</span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><span className="truncate">{author}</span>{platform && <>{" · "}<PlatformName platform={platform} /></>}{status !== "Needs you" && <span className="shrink-0">{" · "}{status}</span>}</span>
      </span>
    </button>;
  }

  async function saveGroup(entry: HomeFeedEntry, group: string, on: boolean) {
    setViewBusy(true); setError(null);
    try {
      if (!source.setGroupPriority) throw new Error("This feed source does not provide private group storage");
      await source.setGroupPriority(entry, group, on); refreshRef.current();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Private group decision could not be saved"); }
    finally { setViewBusy(false); }
  }

  // Home shows only the heading and its empty state until the first card arrives.
  const bare = !snapshot?.entries.length && !snapshot?.historicalEntries?.length;
  const filtersOn = [agent, kind, project].filter(Boolean).length + (history ? 1 : 0);
  const selectClass = "min-h-10 w-36 max-w-full rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return <main className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-background text-foreground" aria-label={NAV_LABEL_HOME}>
    <div className="mx-auto w-full max-w-2xl min-w-0 px-3 pb-[calc(var(--tc-bottom-chrome)+2rem)] pt-6 sm:px-5">
      <header className="mb-6"><h1 className="font-display text-3xl font-semibold tracking-tight">{NAV_LABEL_HOME}</h1><p className="mt-1 text-sm text-muted-foreground">Updates and decisions from your agents.</p></header>
      {ask}
      {!bare && <><div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="home-feed-view">Feed view</label>
        <select id="home-feed-view" aria-label="Feed view" value={selector} className={selectClass} onChange={(event) => changeSelector(event.target.value as FeedSelector)}>
          <option value="information">Information</option><option value="both">Both</option><option value="needs-action">Needs action</option>
        </select>
        {(savingDefault || (!!snapshot && snapshot.settings.defaultSelector !== selector)) && <button type="button" disabled={savingDefault} onClick={() => void saveDefault()} className="min-h-10 rounded-lg border border-border px-3 text-xs disabled:opacity-50">{savingDefault ? "Saving default…" : "Use as default"}</button>}
        <button type="button" aria-pressed={!!agentView} onClick={() => setAgentView(agentView === "list" ? null : "list")} className="ml-auto min-h-10 rounded-lg border border-border px-3 text-sm">Agents</button>
        <button type="button" aria-expanded={filtersOpen} aria-controls="home-feed-filters" onClick={() => setFiltersOpen(!filtersOpen)} className={`min-h-10 rounded-lg border px-3 text-sm ${filtersOn ? "border-primary bg-primary/10 font-medium" : "border-border"}`}>{filtersOn ? `Filter · ${filtersOn}` : "Filter"}</button>
      </div>
      {filtersOpen && <div id="home-feed-filters" className="mb-5 flex flex-wrap gap-2 rounded-xl border border-border p-3">
        <select aria-label="Filter by agent" className={selectClass} value={agent} onChange={(event) => { setAgent(event.target.value); setActive(null); }}><option value="">All agents</option>{[...new Map(entries.map((entry) => [entry.source.sourceId, entry.source.label])).entries()].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <select aria-label="Filter by type" className={selectClass} value={kind} onChange={(event) => { setKind(event.target.value); setActive(null); }}><option value="">All types</option>{[...new Set(entries.map((entry) => entry.state.card.kind))].sort().map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <select aria-label="Filter by project" className={selectClass} value={project} onChange={(event) => { setProject(event.target.value); setActive(null); }}><option value="">All projects</option>{[...new Set(entries.map(projectOf).filter(Boolean))].sort().map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <button type="button" aria-pressed={history} onClick={() => { setHistory(!history); setActive(null); }} className="min-h-10 rounded-lg border border-border px-3 text-sm aria-pressed:border-primary aria-pressed:bg-primary/10">History</button>
      </div>}</>}
      {error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 p-3 text-sm"><p>{error}</p><button type="button" onClick={() => refreshRef.current()} className="mt-2 min-h-9 underline">Try again</button></div>}
      {!snapshot && !error && <p className="text-sm text-muted-foreground">Loading your feed…</p>}
      {agentView && snapshot && (openAgent
        ? <AgentConversation key={openAgent.key} agent={openAgent} source={source} onSaved={onSaved} onBack={() => setAgentView("list")} onOpenCard={(entry) => { setAgentView(null); setActive(entry); }} />
        : <AgentList agents={agents} now={clock} onOpen={setAgentView} />)}
      {!agentView && <>
      {snapshot && !filtered.length && !focused && (bare
        ? <section aria-label={HOME_EMPTY_TITLE} className="rounded-xl border border-border bg-card p-6 text-sm">
          <h2 className="font-display text-lg font-semibold">{HOME_EMPTY_TITLE}</h2>
          <p className="mt-2 text-muted-foreground">{HOME_EMPTY_BODY}</p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <Link to={PATHS.chat} className="inline-flex min-h-10 items-center rounded-lg bg-primary px-4 font-medium text-primary-foreground">{HOME_EMPTY_CHAT}</Link>
            <a href={FEED_SKILL_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{HOME_EMPTY_HOW}</a>
          </div>
        </section>
        : <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{history ? "No answered or snoozed cards." : selector === "needs-action" ? "Nothing needs your action." : "No cards in this view."}</p>)}
      {focused && <section aria-label="Focused card" className="mb-8 min-w-0">
        {fold && <AnswerFold key={fold.response.responseId} entry={focused} sent={fold} agent={focusedAuthor} typed={focusedContext} source={source} onSaved={onSaved} onToggle={() => setSent({ ...fold, open: !fold.open })} />}
        <div hidden={!!fold && !fold.open}>
          <FeedCardView card={cardView(focused, focusedContext)} sample={false} readBody={source.readBody} status={focusedUnsupported ? undefined : cardStatus(focused, focusedContext?.projection, clock, focusedAuthor)} onAuthor={() => setAgentView(agentKey(focused, focusedContext?.record))} agent={{ key: agentKey(focused, focusedContext?.record), profile: agentProfile(focused.state.card.payload) }}>
            <ReportLink entry={focused} />
            {focusedContext ? <SitrepCard key={focusedKey!} entry={focused} record={focusedContext.record} records={focusedContext.records} entries={focusedContext.entries} owner={focusedContext.owner} projection={focusedContext.projection} source={source} now={clock} onSaved={onSaved} onAnswered={onAnswered} onOwnerSaved={() => refreshRef.current()} onNavigate={setActive} reference={reference} actions={nextCard} /> : focusedUnsupported ? <><p role="status" className="mt-4 rounded-xl border border-border p-3 text-sm">Unsupported typed record or unresolved thread event. Original card preserved; no fallback answer action is available.</p><CardActions>{nextCard}<CardDetails>{reference}</CardDetails></CardActions></> : <><AnswerForm key={focusedKey!} entry={focused} source={source} onSaved={onSaved} onAnswered={onAnswered} /><CardHistory entry={focused} />
              <CardActions>
                {needsAttention(focused, clock) && <button type="button" disabled={viewBusy} onClick={() => void snooze()} className={actionClass}>Snooze for 1 hour</button>}
                {nextCard}
                <CardDetails><p>Posted by {focused.source.label} · {focused.source.agentDid}</p><p>{focused.state.card.kind}</p>{reference}</CardDetails>
              </CardActions></>}
          </FeedCardView>
        </div>
        {fold && !fold.open && nextCard && <div className="flex flex-wrap gap-2">{nextCard}</div>}
      </section>}
      {!!listed.length && <nav aria-label="Cards in this view" className="mb-4 space-y-6">
        {sections.map(([heading, rows]) => !!rows.length && <section key={heading} aria-label={heading}>
          <h2 className="mb-1 px-1 text-sm font-medium text-muted-foreground">{heading} · {rows.reduce((count, row) => count + (row.kind === "card" ? 1 : row.items.filter((entry) => keyOf(entry) !== focusedKey).length), 0)}</h2>
          <ul className="divide-y divide-border border-y border-border">{rows.map((row) => {
            if (row.kind === "card") return <li key={keyOf(row.item)}>{navigationCard(row.item)}</li>;
            const first = row.items[0]; const record = first && contextFor(first)?.record; const name = record && cardGroup(record);
            if (!first || !name) throw new Error("Invalid grouped Home card");
            const open = expandedGroups.has(row.name);
            const pinned = groupPriorityFlag(contextFor(first)?.owner.groupPriority?.groups[name], row.items.map((entry) => { const context = contextFor(entry); return !!context && !!cardPriority(context.record, context.projection.state?.priority); }));
            return <li key={row.name}><section aria-label={`Card group ${name}`} className="py-1">
              <div className="flex flex-wrap items-center gap-2"><button type="button" className="flex min-h-12 grow items-center gap-2 px-1 text-left text-sm font-medium" aria-expanded={open} onClick={() => setExpandedGroups((previous) => { const next = new Set(previous); if (next.has(row.name)) next.delete(row.name); else next.add(row.name); return next; })}><ChevronRightIcon aria-hidden className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />{name} · {row.items.length} cards</button><button type="button" disabled={viewBusy} aria-pressed={pinned} className="min-h-10 rounded-lg border border-border px-2 text-xs disabled:opacity-50" onClick={() => void saveGroup(first, name, !pinned)}>{pinned ? "Clear private group priority" : "Mark private group priority"}</button></div>
              {open && <ul className="divide-y divide-border pl-6">{row.items.map((entry) => <li key={keyOf(entry)}>{navigationCard(entry)}</li>)}</ul>}
            </section></li>;
          })}</ul>
        </section>)}
      </nav>}
      </>}
    </div>
  </main>;
}
