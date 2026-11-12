import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDownIcon, CheckIcon, ChevronRightIcon, ChevronUpIcon } from "lucide-react";
import type { FeedResponse, FeedSelector, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { AnswerOptions, answerSummary, OWN_OPTION, OwnAnswerBox, useUndoWindow } from "./AnswerOptions";
import { AnswerSteps, answerHandling } from "./AnswerSteps";
import { AgentConversation, AgentList, agentKey, agentThreads } from "./AgentConversation";
import { agentProfile, AgentMark } from "./AgentMark";
import { cardAuthor, replyRoute, usePostReply } from "./CardReply";
import { CardConversation, plainConversation, typedConversation } from "./CardConversation";
import { actionClass, CardDetails } from "./CardActions";
import { flushSync } from "react-dom";
import { cardStatus } from "./cardStatus";
import { FeedCardView } from "./FeedView";
import { labPageOf, PostPage, PostPreview, postStatus } from "./PostPage";
import { CompactCard, StatusMark } from "./CompactCard";
import { safeUrl, type FeedCard } from "./feedData";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { ShortTime, shortTime } from "./ShortTime";
import { SitrepCard } from "./SitrepCard";
import { typedContexts, type TypedCardContext } from "./sitrepProjection";
import { humanFeedReference, homeFeedKey, homeGroupScope } from "./feedIdentity";
import { cardGroup, cardPriority, compareWaiting, DUE_WINDOW_MS, groupCards, groupPriorityFlag, isClosed, orderPriority, partPending, snoozePresets, type SitrepProjection } from "@tinyboilerplate/core/feed/sitrep";
import { HOME_EMPTY_BODY, HOME_EMPTY_CHAT, HOME_EMPTY_HOW, HOME_EMPTY_TITLE, NAV_LABEL_HOME } from "@/lib/homeStrings";
import { PATHS } from "@/shell/routes";
import { FEED_SKILL_URL } from "./strings";
import { FeedViewSlider } from "./FeedViewSlider";

/** How long ago an answer went, after the pill's "Sent" tag: "3 hrs ago", "1 day ago"; nothing in its first minute. */
export function sentAgo(at: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return "";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hr" : "hrs"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * A labelled on/off switch, as Settings draws it: a 44px target on touch around a 44x24 track. Its off state has
 * an edge, so it reads against the page (design critique #5).
 */
function LabSwitch({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return <label className={`flex min-h-10 items-center gap-2 text-sm ${disabled ? "opacity-50" : ""}`}>
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      className="-my-2.5 flex h-11 w-12 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:my-0 fine:h-6 fine:w-11">
      <span aria-hidden className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-primary" : "bg-input ring-1 ring-inset ring-foreground/15"}`}>
        <span className={`absolute top-1 size-4 rounded-full bg-background shadow-sm transition-transform ${checked ? "left-6" : "left-1"}`} />
      </span>
    </button>
    {label}
  </label>;
}

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
function ResponseStatus({ entry, agent }: { entry: HomeFeedEntry; agent?: string }) {
  const response = entry.state.response;
  if (!response) return null;
  const { acknowledgement, outcome } = answerHandling(entry, response.responseId);
  const detail = outcome?.detail?.message;
  return <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-4 text-sm" role="status" aria-label="Answer status">
    <AnswerSteps sent={response.createdAt} acknowledgement={acknowledgement} outcome={outcome} agent={agent ?? cardAuthor(entry).name} />
    {response.choiceId && <p>{entry.state.card.choices?.find((choice) => choice.id === response.choiceId)?.label ?? response.choiceId}</p>}
    {response.text && <p className="whitespace-pre-wrap break-words">{response.text}</p>}
    {typeof detail === "string" && <p className="whitespace-pre-wrap break-words">{detail}</p>}
  </div>;
}

/** How far (px, after damping) a pull at the top must go before earlier answers load. */
const PULL_PX = 56;
/** Pages the end of the feed may add by itself before it says "That's everything" (design critique #4). */
const MAX_AUTO_LOADS = 8;
interface SentAnswer { key: string; response: FeedResponse; summary: string; open: boolean }
/**
 * What stays of a card once its answer is sent: what was chosen and, while the card is folded away, the
 * answer's steps. It takes focus when it appears, so the result is announced where the card was.
 */
function AnswerFold({ entry, sent, agent, typed, source, onSaved, onToggle }: { entry: HomeFeedEntry; sent: SentAnswer; agent: string; typed?: TypedCardContext; source: HomeFeedSource; onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void; onToggle: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const handling = answerHandling(entry, sent.response.responseId);
  const detail = handling.outcome?.detail?.message;
  return <div ref={ref} role="status" tabIndex={-1} aria-label="Answer sent" className="mb-3 space-y-3 rounded-2xl border border-border bg-card p-4 text-sm text-card-foreground shadow-sm motion-safe:animate-rise-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <div className="flex items-start gap-2">
      <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words"><span className="font-medium">{sent.summary}</span><span className="block text-xs text-muted-foreground">Sent to {agent} · {entry.state.card.title}</span></p>
      <button type="button" aria-expanded={sent.open} onClick={onToggle} className="min-h-10 shrink-0 rounded-lg border border-border px-3 text-sm">{sent.open ? "Hide card" : "Show card"}</button>
    </div>
    {!sent.open && <AnswerSteps sent={sent.response.createdAt} {...handling} agent={agent} />}
    {!sent.open && typeof detail === "string" && <p className="whitespace-pre-wrap break-words">{detail}</p>}
    {/* The conversation stays on the folded card: you can keep commenting, and the agent replies here. */}
    {!sent.open && (typed ? <TypedThread entry={entry} typed={typed} source={source} onSaved={onSaved} /> : <PlainThread entry={entry} source={source} onSaved={onSaved} />)}
  </div>;
}
/** A typed card's conversation, to the agent that can act on it (CardReply's route). */
function TypedThread({ entry, typed, source, onSaved }: { entry: HomeFeedEntry; typed: TypedCardContext; source: HomeFeedSource; onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void }) {
  const route = replyRoute(entry, typed.record, source);
  const post = usePostReply(entry, typed.record, source, onSaved);
  return <CardConversation lines={typedConversation(entry, typed.record, typed.owner)} to={route.to} reason={"reason" in route ? route.reason : undefined} onSend={(text) => post(text, "delivery" in route ? route.delivery : undefined)} />;
}
/** A plain card's conversation: a comment is a card message to the agent that posted it. */
function PlainThread({ entry, source, onSaved }: { entry: HomeFeedEntry; source: HomeFeedSource; onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void }) {
  async function send(text: string) {
    if (!source.sendMessage) throw new Error("No agent can receive a comment here");
    const card = entry.state.card;
    const result = await source.sendMessage(entry, { responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, kind: "message", text, createdAt: new Date().toISOString() });
    onSaved(entry, result);
  }
  return <CardConversation lines={plainConversation(entry)} to={source.sendMessage ? entry.source.label : undefined} onSend={send} />;
}

function AnswerForm({ entry, source, onSaved, onAnswered }: { entry: HomeFeedEntry; source: HomeFeedSource; onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void; onAnswered: (response: FeedResponse, summary: string) => void }) {
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<string | undefined>();
  const [ownOpen, setOwnOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState(false);
  const pendingResponse = useRef<NewFeedResponse | null>(null);
  const hold = useUndoWindow(() => void save());
  const saved = entry.state.response;
  const waiting = saving || hold.seconds !== null;
  async function save() {
    const own = choice === OWN_OPTION.id;
    if (saving || !choice || (own && !text.trim())) return;
    setSaving(true); setError(null);
    const card = entry.state.card;
    // Retain the response identity across a failed/ambiguous write. A retry
    // cannot create a second answer simply because its first response was lost.
    const response = pendingResponse.current ?? {
      responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
      kind: saved ? "followup" as const : "answer" as const,
      ...(choice && !own ? { choiceId: choice } : {}), ...(own ? { text: text.trim() } : {}),
      ...(saved ? { supersedesResponseId: saved.responseId } : {}), createdAt: new Date().toISOString(),
    };
    pendingResponse.current = response;
    try {
      const result = await source.saveResponse(entry, response);
      onSaved(entry, result);
      onAnswered(result, answerSummary(response.choiceId && (card.choices?.find((option) => option.id === response.choiceId)?.label ?? response.choiceId), response.text));
      pendingResponse.current = null;
      setText(""); setChoice(undefined); setOwnOpen(false); setFollowup(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Answer could not be saved");
    } finally { setSaving(false); }
  }
  function editText(value: string) { setText(value); pendingResponse.current = null; }
  // One tap chooses: the option waits out the undo window, then is saved. "Your own answer" opens a box instead.
  function choose(id: string) {
    if (waiting) return;
    if (id === OWN_OPTION.id) { setOwnOpen(!ownOpen); return; }
    if (id !== choice) pendingResponse.current = null;
    setChoice(id); hold.start();
  }
  function sendOwn() {
    if (waiting || !text.trim()) return;
    if (choice !== OWN_OPTION.id) pendingResponse.current = null;
    setChoice(OWN_OPTION.id); hold.start();
  }
  function undo() { hold.undo(); setChoice(undefined); pendingResponse.current = null; }
  if (!entry.state.card.needsResponse) return null;
  return <div className="mt-4 space-y-3">
    <ResponseStatus entry={entry} />
    {saved && !followup ? <button type="button" className="min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => setFollowup(true)}>Add follow-up</button> : <div className="space-y-3">
      {saved && <p className="text-xs text-muted-foreground">A follow-up does not cancel an action already received by the agent.</p>}
      <AnswerOptions options={entry.state.card.choices ?? []} chosen={choice} seconds={hold.seconds} sending={saving} to={entry.source.label} onChoose={(option) => choose(option.id)} onUndo={undo}
        own={{ open: ownOpen, box: <OwnAnswerBox text={text} disabled={waiting} onText={editText} onSend={sendOwn} /> }} />
      {error && <div role="alert" className="text-sm text-destructive"><p>{error}</p><button type="button" disabled={waiting} onClick={() => void save()} className="mt-1 min-h-9 underline">Try again</button></div>}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{hold.status}</p>
    </div>}
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
  // Which card's "Ask me later" times are showing.
  const [laterKey, setLaterKey] = useState<string | null>(null);
  // Feed lab (Sam, 11-12): every card as a short item ("compact"), tapping one opens it in place, or every card
  // open, big card after big card ("full").
  const [size, setSize] = useState<"compact" | "full">("compact");
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  // Feed lab (Sam, 11-12): an optional grid of tiles, "nice for looking at stuff"; not the default.
  const [grid, setGrid] = useState(false);
  // Feed lab: the post whose page is open over the feed.
  const [pageKey, setPageKey] = useState<string | null>(null);
  const scrollTo = useRef<string | null>(null);
  // Feed lab: cards you answered earlier, oldest answer first, shown above the feed. Only a deliberate act loads
  // them (Sam, 11-12: "a pull down or button click, not just scrollable without intent"): a pull at the top on
  // touch, or the "Show earlier answers" button. Scrolling or a wheel at the top never does.
  const [earlier, setEarlier] = useState<HomeFeedEntry[]>([]);
  const [pull, setPull] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const pullStart = useRef<number | null>(null);
  const earlierRef = useRef(earlier);
  earlierRef.current = earlier;
  const loading = useRef({ earlier: false, more: false });
  // While you look at earlier answers (the feed's heading is pushed down the screen): when the top one in view was
  // sent, for the floating pill. Null at the current feed.
  const headerRef = useRef<HTMLElement>(null);
  const [historyAt, setHistoryAt] = useState<string | null>(null);
  // "Go to current" shows only while the feed's heading is below the screen (design critique #9).
  const [currentBelow, setCurrentBelow] = useState(false);
  const measureHistory = useCallback(() => {
    const root = mainRef.current, header = headerRef.current;
    if (!root || !header) return;
    const top = root.getBoundingClientRect().top;
    const headerTop = header.getBoundingClientRect().top;
    setCurrentBelow(headerTop > top + root.clientHeight - 64);
    if (headerTop <= top + 48) { setHistoryAt(null); return; }
    const inView = [...root.querySelectorAll<HTMLElement>("[data-sent-at]")].find((node) => node.getBoundingClientRect().bottom > top + 56);
    setHistoryAt(inView?.dataset.sentAt ?? null);
  }, []);
  /** Loads the next page of earlier answers above the ones shown; the page stays at its top, where they land. */
  const loadEarlier = useCallback(async () => {
    if (!source.loadAnswered || loading.current.earlier) return;
    loading.current.earlier = true;
    try {
      const page = await source.loadAnswered(earlierRef.current[0]?.state.response?.createdAt, 5);
      setEarlier((current) => [...[...page].reverse(), ...current]);
    } finally { loading.current.earlier = false; }
  }, [source]);
  // The end of the feed (design critique #4): automatic loads stop once a page adds nothing this view shows, or
  // after MAX_AUTO_LOADS pages, and the list ends with "That's everything". A change of view or filter starts over.
  const autoLoads = useRef(0);
  const loadedFrom = useRef<number | null>(null);
  const [ended, setEnded] = useState(false);
  const shownCount = useRef(0);
  const loadMore = useCallback(async () => {
    if (!source.loadMore || loading.current.more || ended) return;
    if (autoLoads.current >= MAX_AUTO_LOADS) { setEnded(true); return; }
    loading.current.more = true;
    loadedFrom.current = shownCount.current;
    autoLoads.current += 1;
    try { await source.loadMore(); } finally { loading.current.more = false; }
  }, [source, ended]);
  useEffect(() => { measureHistory(); }, [earlier, size, measureHistory]);
  // Reaching the end of the feed adds cards (downward only; earlier answers never load by scrolling).
  useEffect(() => {
    const root = mainRef.current, node = bottomSentinel.current;
    if (!root || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((seen) => { if (seen.some((item) => item.isIntersecting)) void loadMore(); }, { root, rootMargin: "200px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  });
  // A short list leaves the end in view after a page lands: keep adding until the feed fills the screen.
  useEffect(() => {
    const root = mainRef.current, node = bottomSentinel.current;
    if (!root || !node || root.clientHeight === 0) return;
    if (node.getBoundingClientRect().top < root.getBoundingClientRect().bottom + 200) void loadMore();
  }, [snapshot, loadMore]);
  const chosenSelector = useRef(false);
  const hasDefault = useRef(false);
  const refreshRef = useRef<() => void>(() => {});
  const committed = useRef(new Map<string, FeedResponse>());
  const currentSource = useRef(source);
  currentSource.current = source;

  useEffect(() => {
    let alive = true;
    let running = false;
    let dirty = false;
    let loaded = false;
    chosenSelector.current = false; hasDefault.current = false;
    committed.current.clear();
    setSnapshot(null); setError(null);
    setExpandedGroups(new Set()); setSent(null); setAgentView(null); setEarlier([]); setOpened(new Set());
    const refresh = async () => {
      if (running) { dirty = true; return; }
      running = true;
      do {
        dirty = false;
        try {
          const next = await source.load();
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
    // The card just answered stays where it was, folded to what you chose, until the next answer (critique #2).
    if (sent?.key === keyOf(entry)) return true;
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
  const isOpen = (entry: HomeFeedEntry) => size === "full" || opened.has(keyOf(entry));
  shownCount.current = filtered.length;
  // A load that adds nothing this view shows ends the feed.
  useEffect(() => {
    if (loadedFrom.current === null || loading.current.more) return;
    if (filtered.length <= loadedFrom.current) setEnded(true);
    loadedFrom.current = null;
  }, [filtered.length, snapshot]);
  useEffect(() => { autoLoads.current = 0; loadedFrom.current = null; setEnded(false); }, [selector, agent, kind, project, history]);
  /** Opens a card in place (in the compact view) and brings it into view. */
  function openCard(entry: HomeFeedEntry) {
    const key = keyOf(entry);
    setOpened((current) => new Set(current).add(key));
    scrollTo.current = key;
  }
  // Only the feed scrolls, never the page around it (critique #10), and only when the card's top is out of view.
  useEffect(() => {
    const key = scrollTo.current, root = mainRef.current;
    if (!key || !root) return;
    scrollTo.current = null;
    const node = [...root.querySelectorAll<HTMLElement>("li[data-card-key]")].find((item) => item.dataset.cardKey === key);
    if (!node) return;
    const offset = node.getBoundingClientRect().top - root.getBoundingClientRect().top;
    if (offset < 0 || offset > root.clientHeight - 80) root.scrollTo({ top: root.scrollTop + offset - 16, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  // The card whose answer was just sent folds to a line with its steps, unless it still needs the owner. Until
  // a load confirms the answer the card cannot say so itself, and only an ask's approval steps can still be open.
  const foldFor = (entry: HomeFeedEntry, context?: TypedCardContext) => sent && sent.key === keyOf(entry)
    && !(committed.current.has(sent.key) ? context?.projection.parts.some(partPending) : needsAttention(entry, clock, context?.projection)) ? sent : null;
  const answeredFor = (entry: HomeFeedEntry) => (response: FeedResponse, summary: string) => setSent({ key: keyOf(entry), response, summary, open: false });
  const referenceFor = (entry: HomeFeedEntry) => <p className="text-xs text-muted-foreground" aria-label="Card reference"><code className="select-all break-all" title={homeFeedKey(entry)}>{humanFeedReference(entry, entries)}</code></p>;
  // Everything between the person and each agent, from every card the page has loaded.
  const agents = agentView ? agentThreads([...new Map([...(snapshot?.entries ?? []), ...(snapshot?.historicalEntries ?? [])].map((entry) => [keyOf(entry), entry])).values()], contextFor, source, (entry) => needsAttention(entry, clock, contextFor(entry)?.projection)) : [];
  const openAgent = agentView && agentView !== "list" ? agents.find((agent) => agent.key === agentView) : undefined;
  // "Needs action": every card in the page's order and groups, under two plain headings, what needs you and the
  // rest. "All" and "Information" (feed lab, Sam 11-12): one timeline, newest first, so posts, decisions and updates
  // mix as they came, and the end of the list keeps reaching all three.
  const rowNeedsYou = (row: (typeof navigation)[number]) => (row.kind === "card" ? [row.item] : row.items).some((entry) => sent?.key === keyOf(entry) || needsAttention(entry, clock, contextFor(entry)?.projection));
  const newest = (row: (typeof navigation)[number]) => Math.max(...(row.kind === "card" ? [row.item] : row.items).map((entry) => Date.parse(entry.state.card.createdAt)));
  const sections: [string, typeof navigation][] = selector === "needs-action"
    ? [["Needs you", navigation.filter(rowNeedsYou)], ["Updates", navigation.filter((row) => !rowNeedsYou(row))]]
    : [["", [...navigation].sort((first, second) => newest(second) - newest(first))]];
  // A card counts as seen once it shows open: every card in the full view, the ones you open in the compact view.
  const seenAsked = useRef(new Set<string>());
  const seenNow = (size === "full" ? filtered : filtered.filter((entry) => opened.has(keyOf(entry)) || keyOf(entry) === pageKey)).filter((entry) => !entry.view.seenAt && !seenAsked.current.has(keyOf(entry)));
  useEffect(() => {
    for (const entry of seenNow) {
      const key = keyOf(entry);
      seenAsked.current.add(key);
      void source.markSeen(entry).then(() => {
        const seenAt = new Date().toISOString();
        setSnapshot((current) => updateSnapshotEntry(current, key, (candidate) => ({ ...candidate, view: { ...candidate.view, seenAt } })));
      }).catch(() => { seenAsked.current.delete(key); });
    }
  }, [source, seenNow.map(keyOf).join("|")]);

  const onSaved = useCallback((entry: HomeFeedEntry, response: FeedResponse) => {
    if (currentSource.current !== source) return;
    if (response.kind === "message") { refreshRef.current(); return; }
    committed.current.set(keyOf(entry), response);
    const key = keyOf(entry);
    const update = (candidate: HomeFeedEntry): HomeFeedEntry => ({ ...candidate, state: { ...candidate.state, response, acknowledgement: null, outcome: null } });
    setSnapshot((current) => updateSnapshotEntry(current, key, update));
    refreshRef.current();
  }, [source]);
  function changeSelector(value: FeedSelector) { chosenSelector.current = true; setSelector(value); setHistory(false); }
  async function saveDefault() {
    setSavingDefault(true); setError(null);
    try {
      await source.setDefaultSelector(selector);
      setSnapshot((current) => current ? { ...current, settings: { defaultSelector: selector } } : current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Default could not be saved"); }
    finally { setSavingDefault(false); }
  }
  async function snooze(entry: HomeFeedEntry, until: string) {
    if (viewBusy) return;
    setViewBusy(true); setError(null);
    try {
      await source.snooze(entry, until);
      setSnapshot((current) => updateSnapshotEntry(current, keyOf(entry), (candidate) => ({ ...candidate, view: { ...candidate.view, snoozedUntil: until } })));
      setLaterKey(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Card could not be snoozed"); }
    finally { setViewBusy(false); }
  }

  /** A card as a short item (compact view): its agent, title, short description and where it stands. Tap opens it. */
  function compactCard(entry: HomeFeedEntry) {
    const context = contextFor(entry);
    const author = cardAuthor(entry, context?.record).name;
    const unsupported = (entry.state.card.payload?.sitrep !== undefined || entry.state.card.payload?.sitrepThread !== undefined) && !context;
    return <CompactCard agentKey={agentKey(entry, context?.record)} author={author} platform={agentProfile(entry.state.card.payload)?.platform} createdAt={entry.state.card.createdAt}
      status={unsupported ? undefined : cardStatus(entry, context?.projection, clock, author)} title={entry.state.card.title} description={describe(entry)} onOpen={() => openCard(entry)} />;
  }
  /** A card's one or two lines: what you chose once you have answered it, else its short description or body. */
  function describe(entry: HomeFeedEntry) {
    const response = entry.state.response;
    if (response && !needsAttention(entry, clock, contextFor(entry)?.projection)) {
      const label = response.choiceId ? entry.state.card.choices?.find((choice) => choice.id === response.choiceId)?.label : undefined;
      if (label || response.text) return answerSummary(label, response.text);
    }
    return typeof entry.state.card.payload?.summary === "string" ? entry.state.card.payload.summary : entry.state.card.body;
  }
  /** A tile in the grid: the post's image, or the card's words on a plain panel; its title; where it stands. */
  function gridTile(entry: HomeFeedEntry) {
    const context = contextFor(entry);
    const author = cardAuthor(entry, context?.record).name;
    const page = labPageOf(entry);
    const plain = cardStatus(entry, context?.projection, clock, author);
    const status = page ? postStatus(entry, page, plain) : plain;
    return <button type="button" onClick={() => page ? setPageKey(keyOf(entry)) : openCard(entry)} {...(page ? { "aria-haspopup": "dialog" as const } : { "aria-expanded": false })}
      className="flex h-full w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card text-left text-card-foreground transition-transform duration-150 ease-smooth active:scale-[.985] fine:hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none motion-reduce:active:scale-100">
      {page ? <img src={page.image} alt="" loading="lazy" className="block aspect-[4/3] w-full bg-muted object-cover" />
        : <span className="flex aspect-[4/3] w-full flex-col gap-2 bg-surface-2 p-3"><AgentMark agentKey={agentKey(entry, context?.record)} name={author} small /><span className="line-clamp-4 text-xs leading-4 text-muted-foreground">{describe(entry)}</span></span>}
      <span className="flex flex-1 flex-col gap-1.5 p-2.5">
        <span className={`line-clamp-2 break-words text-sm leading-[18px] ${status === "Needs you" ? "font-semibold" : "font-medium"}`}>{entry.state.card.title}</span>
        <span className="mt-auto flex min-w-0 items-center justify-between gap-2 text-meta text-muted-foreground"><span className="truncate">{author}</span><StatusMark status={status} /></span>
      </span>
    </button>;
  }

  /** A card open: the whole card, as the full view shows every one. In the compact view it can fold back. */
  function fullCard(entry: HomeFeedEntry) {
    const key = keyOf(entry);
    const context = contextFor(entry);
    const unsupported = (entry.state.card.payload?.sitrep !== undefined || entry.state.card.payload?.sitrepThread !== undefined) && !context;
    const author = cardAuthor(entry, context?.record).name;
    const fold = foldFor(entry, context);
    const onAnswered = answeredFor(entry);
    const reference = referenceFor(entry);
    const later = laterKey === key;
    const fewer = (size === "compact" || grid) && <button type="button" aria-expanded onClick={() => setOpened((current) => { const next = new Set(current); next.delete(key); return next; })} className="inline-flex min-h-10 items-center rounded-lg px-1 text-sm text-muted-foreground underline decoration-border underline-offset-4">Show less</button>;
    return <div className="min-w-0">
      {fold && <AnswerFold key={fold.response.responseId} entry={entry} sent={fold} agent={author} typed={context} source={source} onSaved={onSaved} onToggle={() => setSent({ ...fold, open: !fold.open })} />}
      <div hidden={!!fold && !fold.open}>
        <FeedCardView card={cardView(entry, context)} sample={false} readBody={source.readBody} status={unsupported ? undefined : cardStatus(entry, context?.projection, clock, author)} onAuthor={() => setAgentView(agentKey(entry, context?.record))} agent={{ key: agentKey(entry, context?.record), profile: agentProfile(entry.state.card.payload) }}>
          <ReportLink entry={entry} />
          {context ? <SitrepCard key={key} entry={entry} record={context.record} records={context.records} entries={context.entries} owner={context.owner} projection={context.projection} source={source} now={clock} onSaved={onSaved} onAnswered={onAnswered} onOwnerSaved={() => refreshRef.current()} onNavigate={openCard} reference={reference} end={fewer || undefined} />
            : unsupported ? <div className="mt-4 space-y-4"><p role="status" className="rounded-xl border border-border p-3 text-sm">Unsupported typed record or unresolved thread event. Original card preserved; no fallback answer action is available.</p><div className="border-t border-border pt-3"><CardDetails end={fewer || undefined}>{reference}</CardDetails></div></div>
            : <div className="mt-4 space-y-4">
              <AnswerForm key={key} entry={entry} source={source} onSaved={onSaved} onAnswered={onAnswered} />
              <PlainThread entry={entry} source={source} onSaved={onSaved} />
              {/* The card's foot (Sam, 11-12): Ask me later beside Details; its times open under it. */}
              <div className="border-t border-border pt-3"><CardDetails end={fewer || undefined} actions={needsAttention(entry, clock) && <button type="button" disabled={viewBusy} aria-expanded={later} onClick={() => setLaterKey(later ? null : key)} className={actionClass}>Ask me later</button>}>
                <p>Posted by {entry.source.label} · {entry.source.agentDid}</p><p>{entry.state.card.kind}</p><CardHistory entry={entry} />{reference}</CardDetails></div>
              {later && needsAttention(entry, clock) && <section aria-label="Ask me later" className="space-y-2 rounded-xl border border-border p-3 text-sm"><p className="font-medium">Ask me again</p>
                <div className="flex flex-wrap gap-2">{snoozePresets(clock).slice(0, 3).map((preset) => <button key={preset.id} type="button" disabled={viewBusy} onClick={() => void snooze(entry, preset.until)} className={actionClass}>{preset.label}</button>)}</div>
              </section>}
            </div>}
        </FeedCardView>
      </div>
    </div>;
  }
  /** A post (feed lab): its preview in both views; tapping it opens its page. */
  function postCard(entry: HomeFeedEntry) {
    const context = contextFor(entry);
    const author = cardAuthor(entry, context?.record).name;
    const page = labPageOf(entry)!;
    return <PostPreview entry={entry} page={page} author={author} agentKey={agentKey(entry, context?.record)} platform={agentProfile(entry.state.card.payload)?.platform}
      status={postStatus(entry, page, cardStatus(entry, context?.projection, clock, author))} full={size === "full"} onOpen={() => setPageKey(keyOf(entry))} />;
  }
  /**
   * A card in the list, short or open, or a tile in the grid (a card opened from the grid spans its row).
   * `answered`: one of the answers above the feed, marked with when it was sent.
   */
  const cardItem = (entry: HomeFeedEntry, answered = false) => {
    const key = keyOf(entry);
    const page = labPageOf(entry);
    const wide = grid && !page && opened.has(key);
    return <li key={key} data-card-key={key} data-sent-at={answered ? entry.state.response?.createdAt : undefined} className={`min-w-0 scroll-mt-4 ${wide ? "col-span-full" : ""}`}>
      {grid && !wide ? gridTile(entry) : page ? postCard(entry) : isOpen(entry) ? fullCard(entry) : compactCard(entry)}</li>;
  };
  const listClass = grid ? "grid grid-cols-2 gap-3 sm:grid-cols-3" : size === "compact" ? "space-y-2" : "space-y-4";
  /**
   * Changes how the list is drawn (full cards, grid) without losing your place (Sam, 11-12: "jarring, randomly
   * places in the page"): the card at the top of the screen, or an open one in view, stays where it was. Cards on
   * screen morph to their new size while their content crossfades (View Transitions, about 250 ms); cards off
   * screen just change. No motion when the person asks for less, or where the browser has no View Transitions.
   */
  function relayout(change: () => void) {
    const root = mainRef.current;
    if (!root) { change(); return; }
    const top = root.getBoundingClientRect().top;
    const bottom = top + root.clientHeight;
    const cards = [...root.querySelectorAll<HTMLElement>("li[data-card-key]")];
    const visible = cards.filter((node) => { const box = node.getBoundingClientRect(); return box.bottom > top && box.top < bottom; });
    const held = visible.find((node) => opened.has(node.dataset.cardKey ?? "")) ?? visible.find((node) => node.getBoundingClientRect().bottom > top + 1);
    const heldKey = held?.dataset.cardKey;
    const offset = held ? held.getBoundingClientRect().top - top : 0;
    const apply = () => {
      flushSync(change);
      const after = heldKey ? [...root.querySelectorAll<HTMLElement>("li[data-card-key]")].find((node) => node.dataset.cardKey === heldKey) : undefined;
      if (after) root.scrollTop += after.getBoundingClientRect().top - top - offset;
    };
    const transition = (document as Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } }).startViewTransition;
    if (!transition || matchMedia("(prefers-reduced-motion: reduce)").matches) { apply(); return; }
    visible.forEach((node, index) => { node.style.setProperty("view-transition-name", `lab-card-${index}`); });
    transition.call(document, apply).finished.finally(() => visible.forEach((node) => node.style.removeProperty("view-transition-name")));
  }
  const pageEntry = pageKey ? [...(snapshot?.entries ?? []), ...(snapshot?.historicalEntries ?? [])].find((entry) => keyOf(entry) === pageKey) : undefined;
  const pageOpen = pageEntry && labPageOf(pageEntry);

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
  // No browser scroll anchoring: it would hold the end of the list in view as cards land, loading more forever.
  return <main ref={mainRef} onScroll={measureHistory} className="h-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-y-contain bg-background text-foreground [overflow-anchor:none]" aria-label={NAV_LABEL_HOME}
    onTouchStart={(event) => { pullStart.current = (mainRef.current?.scrollTop ?? 1) <= 0 && source.loadAnswered ? event.touches[0]!.clientY : null; }}
    onTouchMove={(event) => { if (pullStart.current !== null) setPull(Math.max(0, Math.min((event.touches[0]!.clientY - pullStart.current) / 2, 80))); }}
    onTouchEnd={() => { if (pull >= PULL_PX) void loadEarlier(); pullStart.current = null; setPull(0); }}>
    {/* Feed lab: pull down at the top for the cards you answered earlier (or use the button, without touch). */}
    {source.loadAnswered && <div aria-hidden style={{ height: pull }} className="flex items-end justify-center overflow-hidden text-xs text-muted-foreground">{pull >= PULL_PX ? "Release for earlier answers" : "Pull for earlier answers"}</div>}
    {/* While a post's page is open, the feed behind it takes no focus or taps (design critique #3). */}
    <div className="mx-auto w-full max-w-2xl min-w-0 px-3 pb-6 pt-6 sm:px-5" inert={!!pageEntry}>
      {/* Feed lab (Sam, 11-12): in earlier answers, a pill floats at the top with when the ones in view were sent.
          Its look is uiverse.io "quiet-rat-82" by ahkamboh (MIT), in the app's styling. */}
      {historyAt && <div className="pointer-events-none sticky top-2 z-20 flex h-0 justify-center">
        <span className="inline-flex h-fit items-center whitespace-nowrap rounded-full bg-zinc-900 p-1.5 pr-3.5 leading-none text-zinc-100 shadow-lg shadow-black/15 dark:bg-zinc-800 dark:shadow-black/50 dark:ring-1 dark:ring-white/10">
          <span className="mr-2.5 rounded-full bg-zinc-700 px-2 py-1 text-[11px] font-bold uppercase tracking-wide dark:bg-zinc-600">Sent</span>
          {sentAgo(historyAt, clock) && <span className="text-sm font-semibold"> {sentAgo(historyAt, clock)}</span>}
        </span>
      </div>}
      {source.loadAnswered && <div className="mb-4 flex justify-center">
        <button type="button" onClick={() => void loadEarlier()} className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border px-4 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronUpIcon aria-hidden className="size-4" />Show earlier answers</button>
      </div>}
      {!!earlier.length && <section aria-label="Answered earlier" className="mb-6">
        <h2 className="mb-2 px-1 text-label font-semibold uppercase tracking-[0.06em] text-muted-foreground">Answered earlier</h2>
        <ul className={listClass}>{earlier.map((loaded) => cardItem(snapshot?.historicalEntries?.find((candidate) => keyOf(candidate) === keyOf(loaded)) ?? loaded, true))}</ul>
      </section>}
      <header ref={headerRef} className="mb-6 scroll-mt-4"><h1 className="font-display text-3xl font-semibold tracking-tight">{NAV_LABEL_HOME}</h1><p className="mt-1 text-sm text-muted-foreground">Updates and decisions from your agents.</p></header>
      {ask}
      {/* While Agents is open the view controls do nothing, so they step aside (design critique #5). */}
      {!bare && <>{!agentView && <FeedViewSlider value={selector} onValueChange={changeSelector} className="mb-3" />}
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* Feed lab (Sam, 11-12): a toggle between every card short, like a list of posts, and every card open;
            and an optional grid of tiles. Both keep your place and morph the cards on screen (relayout). */}
        {!agentView && <>
          <LabSwitch label="Full cards" checked={size === "full"} disabled={grid} onChange={(on) => relayout(() => { setSize(on ? "full" : "compact"); setOpened(new Set()); })} />
          <LabSwitch label="Grid" checked={grid} onChange={(on) => relayout(() => { setGrid(on); setOpened(new Set()); })} />
        </>}
        <span className="ml-auto flex items-center gap-2">
          <button type="button" aria-pressed={!!agentView} onClick={() => setAgentView(agentView === "list" ? null : "list")} className="min-h-11 rounded-lg border border-border px-3 text-sm fine:min-h-10 aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background">Agents</button>
          {!agentView && <button type="button" aria-expanded={filtersOpen} aria-controls="home-feed-filters" onClick={() => setFiltersOpen(!filtersOpen)} className={`min-h-11 rounded-lg border px-3 text-sm fine:min-h-10 ${filtersOn ? "border-primary bg-primary/10 font-medium" : "border-border"}`}>{filtersOn ? `Filter · ${filtersOn}` : "Filter"}</button>}
        </span>
      </div>
      {filtersOpen && <div id="home-feed-filters" className="mb-5 flex flex-wrap gap-2 rounded-xl border border-border p-3">
        <select aria-label="Filter by agent" className={selectClass} value={agent} onChange={(event) => setAgent(event.target.value)}><option value="">All agents</option>{[...new Map(entries.map((entry) => [entry.source.sourceId, entry.source.label])).entries()].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <select aria-label="Filter by type" className={selectClass} value={kind} onChange={(event) => setKind(event.target.value)}><option value="">All types</option>{[...new Set(entries.map((entry) => entry.state.card.kind))].sort().map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <select aria-label="Filter by project" className={selectClass} value={project} onChange={(event) => setProject(event.target.value)}><option value="">All projects</option>{[...new Set(entries.map(projectOf).filter(Boolean))].sort().map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <button type="button" aria-pressed={history} onClick={() => setHistory(!history)} className="min-h-10 rounded-lg border border-border px-3 text-sm aria-pressed:border-primary aria-pressed:bg-primary/10">History</button>
        {(savingDefault || (!!snapshot && snapshot.settings.defaultSelector !== selector)) && <button type="button" disabled={savingDefault} onClick={() => void saveDefault()} className="min-h-11 rounded-lg border border-border px-3 text-sm disabled:opacity-50 fine:min-h-10">{savingDefault ? "Saving default…" : "Use as default"}</button>}
      </div>}</>}
      {error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 p-3 text-sm"><p>{error}</p><button type="button" onClick={() => refreshRef.current()} className="mt-2 min-h-9 underline">Try again</button></div>}
      {!snapshot && !error && <p className="text-sm text-muted-foreground">Loading your feed…</p>}
      {agentView && snapshot && (openAgent
        ? <AgentConversation key={openAgent.key} agent={openAgent} source={source} onSaved={onSaved} onBack={() => setAgentView("list")} onOpenCard={(entry) => { setAgentView(null); openCard(entry); }} />
        : <AgentList agents={agents} now={clock} onOpen={setAgentView} />)}
      {!agentView && <>
      {snapshot && !filtered.length && (bare
        ? <section aria-label={HOME_EMPTY_TITLE} className="rounded-xl border border-border bg-card p-6 text-sm">
          <h2 className="font-display text-lg font-semibold">{HOME_EMPTY_TITLE}</h2>
          <p className="mt-2 text-muted-foreground">{HOME_EMPTY_BODY}</p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <Link to={PATHS.chat} className="inline-flex min-h-10 items-center rounded-lg bg-primary px-4 font-medium text-primary-foreground">{HOME_EMPTY_CHAT}</Link>
            <a href={FEED_SKILL_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{HOME_EMPTY_HOW}</a>
          </div>
        </section>
        : <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{history ? "No answered or snoozed cards." : selector === "needs-action" ? "Nothing needs your action." : "No cards in this view."}</p>)}
      {!!filtered.length && <div className="mb-4 space-y-6">
        {sections.map(([heading, rows]) => !!rows.length && <section key={heading} aria-label={heading}>
          {heading && <h2 className="mb-2 flex items-baseline justify-between px-1 text-label font-semibold uppercase tracking-[0.06em] text-muted-foreground"><span>{heading}</span><span className="tabular-nums">{rows.reduce((count, row) => count + (row.kind === "card" ? 1 : row.items.length), 0)}</span></h2>}
          <ul className={listClass}>{rows.map((row) => {
            if (row.kind === "card") return cardItem(row.item);
            const first = row.items[0]; const record = first && contextFor(first)?.record; const name = record && cardGroup(record);
            if (!first || !name) throw new Error("Invalid grouped Home card");
            const open = expandedGroups.has(row.name);
            const pinned = groupPriorityFlag(contextFor(first)?.owner.groupPriority?.groups[name], row.items.map((entry) => { const context = contextFor(entry); return !!context && !!cardPriority(context.record, context.projection.state?.priority); }));
            return <li key={row.name} className="col-span-full"><section aria-label={`Card group ${name}`} className="py-1">
              <div className="flex flex-wrap items-center gap-2"><button type="button" className="flex min-h-12 grow items-center gap-2 px-1 text-left text-sm font-medium" aria-expanded={open} onClick={() => setExpandedGroups((previous) => { const next = new Set(previous); if (next.has(row.name)) next.delete(row.name); else next.add(row.name); return next; })}><ChevronRightIcon aria-hidden className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />{name} · {row.items.length} cards</button><button type="button" disabled={viewBusy} aria-pressed={pinned} className="min-h-10 rounded-lg border border-border px-2 text-xs disabled:opacity-50" onClick={() => void saveGroup(first, name, !pinned)}>{pinned ? "Clear private group priority" : "Mark private group priority"}</button></div>
              {open && <ul className={`pl-3 ${listClass}`}>{row.items.map((entry) => cardItem(entry))}</ul>}
            </section></li>;
          })}</ul>
        </section>)}
      </div>}
      {/* Feed lab: the end of the list loads more cards, so the feed never stops short. */}
      {source.loadMore && !!filtered.length && !ended && <div ref={bottomSentinel} aria-hidden className="h-8" />}
      {source.loadMore && !!filtered.length && ended && <p className="py-6 text-center text-meta text-muted-foreground">That's everything · updated {shortTime(new Date(clock).toISOString(), clock)}</p>}
      </>}
      {/* Feed lab (Sam, 11-12): from earlier answers, one tap back to now. Its look is uiverse.io
          "selfish-dolphin-96" by ParasSalunke (MIT), in the app's styling: dark on light, light on dark. */}
      {historyAt && currentBelow && <div className="sticky bottom-4 z-20 flex h-0 items-end justify-center">
        <button type="button" onClick={() => { const root = mainRef.current, header = headerRef.current; if (root && header) root.scrollTop += header.getBoundingClientRect().top - root.getBoundingClientRect().top - 16; }}
          className="group relative inline-block rounded-xl bg-zinc-800 p-px font-semibold leading-6 text-white shadow-2xl shadow-zinc-900/40 transition-transform duration-300 ease-in-out hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 motion-reduce:transition-none dark:bg-zinc-300 dark:text-zinc-900 dark:shadow-black/60 dark:focus-visible:ring-zinc-100 dark:focus-visible:ring-offset-background">
          <span aria-hidden className="absolute inset-0 rounded-xl bg-zinc-500 opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
          <span className="relative z-10 flex min-h-11 items-center gap-2 rounded-xl bg-zinc-950 px-4 text-sm dark:bg-zinc-50">Go to current<ArrowDownIcon aria-hidden className="size-4 transition-transform duration-500 group-hover:translate-y-0.5" /></span>
        </button>
      </div>}
    </div>
    {pageEntry && pageOpen && (() => {
      const author = cardAuthor(pageEntry).name;
      return <PostPage key={pageKey} entry={pageEntry} page={pageOpen} source={source} author={author} onSaved={onSaved} onClose={() => setPageKey(null)}
        card={(children) => <FeedCardView card={cardView(pageEntry)} sample={false} readBody={source.readBody} status={cardStatus(pageEntry, undefined, clock, author)} onAuthor={() => { setPageKey(null); setAgentView(agentKey(pageEntry)); }} agent={{ key: agentKey(pageEntry), profile: agentProfile(pageEntry.state.card.payload) }}>{children}</FeedCardView>}
        status={pageEntry.state.response ? <ResponseStatus entry={pageEntry} agent={author} /> : null}
        footer={<PlainThread entry={pageEntry} source={source} onSaved={onSaved} />} />;
    })()}
  </main>;
}
