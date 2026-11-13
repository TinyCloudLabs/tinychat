import { Link } from "react-router-dom";
import { PATHS } from "@/shell/routes";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon, SlidersHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import type { FeedResponse, FeedSelector, NewFeedMessage, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { HomeCardView } from "./FeedView";
import { safeUrl, type FeedCard } from "./feedData";
import type { HeldAnswerOutcome, HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { SitrepCard } from "./SitrepCard";
import { typedContexts, type TypedCardContext } from "./sitrepProjection";
import { humanFeedReference, homeFeedKey, homeGroupScope } from "./feedIdentity";
import { CardConversation, plainConversation } from "./CardConversation";
import { isReplyOnlyRevision, storedRevisionEntry } from "./replyOnlyRevision";
import { AnsweredPanel, AnswerFailedLine, cardClass, ErrorLine, HELD_ANSWER_COPY, NOT_SENT_COPY, NotSent, optionText, PendingSendContext, primaryPillClass, quietClass, Reference, usePendingSend } from "./cardKit";
import { AnswerOptions, OWN_OPTION, OwnAnswerBox } from "./AnswerOptions";
import { actionClass, CardDetails, footActionClass } from "./CardActions";
import { isOwnerAction, ownerClosure } from "./ownerActions";
import { CompactCard, type Replies } from "./CompactCard";
import { cardStatus } from "./cardStatus";
import { agentProfile } from "./AgentMark";
import { HistoryTimeline, historyFromEntry } from "./HistoryTimeline";
import { FeedTabs, type FeedTab } from "./FeedTabs";
import { FloatingHeader } from "./FloatingHeader";
import { AgentsPill } from "./AgentMarks";
import { PendingCard, type PendingItem } from "./PendingCard";
import { MorphConfig, MorphItem, MotionFeatures } from "./densityMorph";
import { useUndoBar } from "./UndoBar";
import { BriefButton, LazyBriefSheet } from "./BriefButton";
import { briefOf } from "./brief";
import { shortTime } from "./ShortTime";
import { PostPreview } from "./PostPreview";
import { lazyTab } from "@/shell/lazyTab";
import { labPageOf, postStatus } from "./postAnswers";
import { cardGroup, cardPriority, compareWaiting, DUE_WINDOW_MS, groupCards, groupPriorityFlag, isClosed, orderPriority, parseSitrepCardPayload, snoozePresets, type SitrepProjection } from "@tinyboilerplate/core/feed/sitrep";
import { HOME_EMPTY_BODY, HOME_EMPTY_CHAT, HOME_EMPTY_HOW, HOME_EMPTY_TITLE, NAV_LABEL_HOME } from "@/lib/homeStrings";
import { markFeedFresh } from "@/lib/localFirst/requestLanes";
import { AgentPrompt } from "@/home/AgentPromptCard";
import { FEED_SKILL_URL } from "./strings";

const LazyAgentView = lazyTab("your agents", () => import("./AgentView").then((module) => module.AgentView));
const LazyFilterPanel = lazyTab("Filter", () => import("./FilterPanel").then((module) => module.FilterPanel));
/** A post's page, in a chunk of its own: boot never needs it (TC-2882). */
const LazyPostPage = lazyTab("the post", () => import("./PostPage").then((module) => module.PostPage));

function keyOf(entry: HomeFeedEntry): string {
  const card = entry.state.card;
  return JSON.stringify([entry.source.sourceId, card.cardId, card.revision, card.issuanceId]);
}
function isTypedPayload(entry: HomeFeedEntry): boolean {
  return entry.state.card.payload?.sitrep !== undefined || entry.state.card.payload?.sitrepThread !== undefined;
}
/** A typed card's revision whose board record is closed: the record's last word. */
function closesRecord(entry: HomeFeedEntry): boolean {
  const record = parseSitrepCardPayload(entry.state.card.payload?.sitrep)?.record;
  return !!record && record.kind === entry.state.card.kind && isClosed(record);
}
function snoozedNow(entry: HomeFeedEntry, now: number): boolean {
  return Date.parse(entry.view.snoozedUntil ?? "") > now;
}
function needsAttention(entry: HomeFeedEntry, now: number, typed?: SitrepProjection): boolean {
  if (isTypedPayload(entry)) return !!typed?.needsAction && !snoozedNow(entry, now);
  return entry.state.card.needsResponse && !entry.state.response && !snoozedNow(entry, now);
}
function compare(a: HomeFeedEntry, b: HomeFeedEntry): number {
  return b.state.card.urgency - a.state.card.urgency || a.state.card.createdAt.localeCompare(b.state.card.createdAt) || keyOf(a).localeCompare(keyOf(b));
}
function projectOf(entry: HomeFeedEntry): string {
  const project = entry.state.card.payload?.project;
  return typeof project === "string" ? project : "";
}
/** The Type filter's value: "question" and "ask" are one kind for the owner. */
function kindOf(entry: HomeFeedEntry): string {
  const kind = entry.state.card.kind;
  return kind === "question" ? "ask" : kind;
}
/** Who a card is from: a typed card may name a crew member who posted through another agent's connection. */
function cardAuthor(entry: HomeFeedEntry, record?: BoardRecord): { name: string; via?: string } {
  const from = record?.from.trim();
  return from && from !== entry.source.label ? { name: from, via: entry.source.label } : { name: entry.source.label };
}
/** One mark and colour per agent the owner sees: the connection, and the crew member a typed card names. */
function agentKey(entry: HomeFeedEntry, record?: BoardRecord): string {
  return JSON.stringify([entry.source.sourceId, cardAuthor(entry, record).name]);
}
const isoField = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
/**
 * A card's timing and priority, each optional and set by its agent (card guide v2). `expiresAt` ("matters until"):
 * past it, the card leaves the feed for History, marked expired. `deadline`: when an answer is due. `priority`: 0
 * (highest) to 5. Plain cards carry them in `payload`; typed cards' records carry deadline and expiry.
 */
function cardTiming(entry: HomeFeedEntry, context?: TypedCardContext): { deadline?: string; expiresAt?: string; priority?: number } {
  const payload = entry.state.card.payload ?? {};
  const record = context?.record as { deadline?: unknown; expiresAt?: unknown } | undefined;
  const priority = typeof payload.priority === "number" && Number.isInteger(payload.priority) && payload.priority >= 0 && payload.priority <= 5 ? payload.priority : undefined;
  const deadline = isoField(payload.deadline) ?? isoField(record?.deadline);
  const expiresAt = isoField(payload.expiresAt) ?? isoField(record?.expiresAt);
  return { ...(deadline ? { deadline } : {}), ...(expiresAt ? { expiresAt } : {}), ...(priority !== undefined ? { priority } : {}) };
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
    // Replies on a plain card render in its conversation, not in the body.
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
  return <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 max-w-full items-center break-all text-sm underline underline-offset-[3px]">{typeof label === "string" ? label : "Full report"}</a>;
}

/** The saved answer in words: the option label, never its id; "got it" only once the agent acknowledged. */
function ResponseStatus({ entry, focusOnMount }: { entry: HomeFeedEntry; focusOnMount: boolean }) {
  const { response, acknowledgement, outcome } = entry.state;
  if (!response) return null;
  const agent = entry.source.label;
  const received = acknowledgement?.responseId === response.responseId;
  const result = outcome?.responseId === response.responseId ? outcome : null;
  const detail = result?.detail?.message;
  const choice = response.choiceId ? entry.state.card.choices?.find((option) => option.id === response.choiceId) : undefined;
  const label = choice && optionText(choice.label);
  return <AnsweredPanel focusOnMount={focusOnMount}>
    <p>{label ? <>You chose <b className="font-semibold">{label}</b>.</> : "You answered."}{received && ` ${agent} got it.`}{result && (result.phase === "succeeded" ? ` ${agent} finished it.` : ` ${agent} couldn't finish it.`)}</p>
    {response.text && <p className="whitespace-pre-wrap">{response.text}</p>}
    {typeof detail === "string" && <p className="whitespace-pre-wrap">{detail}</p>}
  </AnsweredPanel>;
}

/** The card's facts and history, in Details. */
function CardFacts({ entry, reference, priority }: { entry: HomeFeedEntry; reference: ReactNode; priority?: number }) {
  const agent = entry.state.card.payload?.agent;
  const job = agent && typeof agent === "object" && typeof (agent as Record<string, unknown>).job === "string" ? (agent as Record<string, string>).job : undefined;
  const rows: [string, ReactNode][] = [
    ["Agent", entry.source.label],
    ["Agent ID", <code className="block truncate select-all text-xs">{entry.source.agentDid}</code>],
    ["Type", entry.state.card.kind.charAt(0).toUpperCase() + entry.state.card.kind.slice(1)],
    ...(job ? [["Working on", job] as [string, ReactNode]] : []),
    ...(projectOf(entry) ? [["Project", projectOf(entry)] as [string, ReactNode]] : []),
    ["Reference", reference],
    // P0 and P1 show on the card itself; every level shows here.
    ...(priority !== undefined ? [["Priority", `P${priority}`] as [string, ReactNode]] : []),
  ];
  return <>
    <dl>{rows.map(([term, value]) => <div key={term} className="flex items-baseline justify-between gap-4 border-t border-border py-2 first:border-t-0 first:pt-0"><dt className="shrink-0 text-muted-foreground">{term}</dt><dd className="min-w-0 text-right">{value}</dd></div>)}</dl>
    <section aria-label="Card history" className="mt-4"><p className="mb-2 text-xs font-medium text-muted-foreground">History</p><HistoryTimeline items={historyFromEntry({ ...entry, responses: (entry.responses ?? []).filter((response) => !isOwnerAction(response)) })} /></section>
  </>;
}

/** What the page does for a card's foot: the actions that take a card away go through its undo bar. */
interface FootActions {
  /** Drop this card (a decision) or Acknowledge (an update). */
  onClose: (kind: "drop" | "acknowledge") => void;
  /** Ask me later / Show me later. */
  onLater: (until: string) => void;
  /** "Bring back now" on a snoozed card opened from the Snoozed list. */
  wake?: ReactNode;
}

/**
 * An untyped card's answer, conversation and foot. A decision: one tap on an option, or "Your own answer", sent after
 * the 5 s undo window and held in the outbox until it lands. An update: nothing to answer; it is acknowledged.
 */
function AnswerForm({ entry, drafts, draftKey, answered, revisions, source, now, attention, closed, reference, priority, stale = false, onRefused, onSaved, foot }: {
  entry: HomeFeedEntry; source: HomeFeedSource; now: number; attention: boolean; reference: ReactNode; priority?: number;
  /**
   * "Your own answer" drafts by card lineage (`draftKey`), owned by the feed: a card folded with "Show less" (it
   * unmounts) keeps what was typed, and a new source (another owner) starts empty.
   */
  drafts: Map<string, string>;
  draftKey: string;
  /**
   * The revision that holds the card's stored answer, when an earlier revision was answered and only agent replies
   * followed. The answer stays bound to that issuance: it is shown on this card, and a follow-up still names it.
   */
  answered?: HomeFeedEntry;
  /** The card's other revisions Home holds (for its conversation). */
  revisions: readonly HomeFeedEntry[];
  /** Dropped or acknowledged already: no closing action. */
  closed: boolean;
  /** A newer issuance replaced this card: its draft stays, but it can no longer be answered. */
  stale?: boolean;
  /** An answer whose countdown ended after the card was replaced: nothing was written. */
  onRefused: (label: string) => void;
  onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void;
  foot: FootActions;
}) {
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? "");
  const setText = (value: string) => { setTextState(value); if (value) drafts.set(draftKey, value); else drafts.delete(draftKey); };
  const [choice, setChoice] = useState<string>();
  const [ownOpen, setOwnOpen] = useState(() => drafts.has(draftKey));
  const [saving, setSaving] = useState(false);
  // The answer whose send failed: whether it is still held is read when the line renders.
  const [failed, setFailed] = useState<{ target: HomeFeedEntry; responseId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState(false);
  const [later, setLater] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const countdown = usePendingSend({ stale, onRefused });
  const pendingResponse = useRef<{ key: string; response: NewFeedResponse } | null>(null);
  const pendingMessage = useRef<{ text: string; message: NewFeedMessage } | null>(null);
  const card = entry.state.card;
  const info = !card.needsResponse;
  // Writes go to the answered issuance when there is one, otherwise to the card as it is now.
  const target = answered ?? entry;
  const saved = target.state.response;
  // Read when a countdown commits, so an answer re-targets to a reply-only revision that arrived meanwhile.
  const live = useRef({ target, saved, text });
  live.current = { target, saved, text };
  async function save(chosen: string) {
    const { target, saved, text } = live.current;
    const own = chosen === OWN_OPTION.id;
    if (saving || (own && !text.trim())) return;
    setSaving(true); setError(null); setFailed(null);
    const card = target.state.card;
    // Retain the response identity across a failed/ambiguous write. A retry of the same answer to the same
    // issuance cannot create a second one.
    const key = JSON.stringify([card.cardId, card.revision, card.issuanceId, own ? null : chosen, own ? text.trim() : ""]);
    const response = pendingResponse.current?.key === key ? pendingResponse.current.response : {
      responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
      kind: saved ? "followup" as const : "answer" as const,
      ...(own ? { text: text.trim() } : { choiceId: chosen }),
      ...(saved ? { supersedesResponseId: saved.responseId } : {}), createdAt: new Date().toISOString(),
    };
    pendingResponse.current = { key, response };
    try {
      // Held until confirmed: a page that closes before this write lands sends it at the next launch.
      const result = await source.saveResponse(target, response, undefined, { hold: true });
      onSaved(target, result);
      pendingResponse.current = null;
      setText(""); setChoice(undefined); setOwnOpen(false); setFollowup(false); setJustSaved(true);
    } catch {
      setFailed({ target, responseId: response.responseId });
    } finally { setSaving(false); }
  }
  /** A comment to the publishing agent (the card-message path). A retry reuses its id. */
  async function message(value: string): Promise<boolean> {
    if (!source.sendMessage) return false;
    setError(null);
    const draft = pendingMessage.current?.text === value ? pendingMessage.current.message
      : { responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, kind: "message" as const, text: value, createdAt: new Date().toISOString() };
    pendingMessage.current = { text: value, message: draft };
    try {
      const result = await source.sendMessage(entry, draft);
      pendingMessage.current = null;
      onSaved(entry, result);
      return true;
    } catch { return false; }
  }
  const asking = !info && (!saved || followup);
  function choose(id: string, label: string) {
    if (stale || saving || countdown.pending) return;
    setChoice(id);
    countdown.start(label, () => void save(id));
  }
  function sendOwn() {
    if (stale || saving || countdown.pending || !text.trim()) return;
    setChoice(OWN_OPTION.id);
    countdown.start(NOT_SENT_COPY.yourAnswer, () => void save(OWN_OPTION.id));
  }
  function undo() { countdown.undo(); setChoice(undefined); }
  const timing = cardTiming(entry);
  const timingLine = [timing.deadline && `Due ${shortTime(timing.deadline, now)}`, timing.expiresAt && `Matters until ${shortTime(timing.expiresAt, now)}`, timing.priority !== undefined && `Priority P${timing.priority}`].filter(Boolean).join(" · ");
  const thread = <CardConversation lines={plainConversation(entry, revisions)} to={source.sendMessage ? entry.source.label : undefined} stale={stale}
    onSend={message} onResend={(line) => message(line.text)} {...(info ? { composer: { open: commenting, onOpenChange: setCommenting } } : {})} />;
  const laterWord = info ? "Show me later" : "Ask me later";
  return <div className="mt-4 space-y-4">
    {timingLine && <p className="text-xs text-muted-foreground">{timingLine}</p>}
    {!info && saved && !asking && <ResponseStatus entry={target} focusOnMount={justSaved} />}
    {asking && followup && <p className="text-[13px] text-muted-foreground">A new answer replaces your earlier one. It can't undo what {entry.source.label} already did.</p>}
    {asking && <AnswerOptions options={card.choices ?? []} pending={countdown.pending && choice ? { choiceId: choice, seconds: countdown.pending.seconds } : null}
      saving={saving ? choice : undefined} chosen={failed ? choice : undefined} disabled={stale} onChoose={choose} onUndo={undo}
      own={{ open: ownOpen, onOpen: setOwnOpen, box: <OwnAnswerBox text={text} disabled={stale || !!countdown.pending || saving} onText={(value) => { setText(value); pendingResponse.current = null; }} onSend={sendOwn} onCancel={() => { setText(""); setOwnOpen(false); pendingResponse.current = null; }}
        state={choice === OWN_OPTION.id ? (saving ? "sending" : failed ? "error" : "idle") : "idle"} onRetry={() => void save(OWN_OPTION.id)} /> }} />}
    {thread}
    {failed ? <AnswerFailedLine held={!!source.holdsAnswer?.(failed.target, failed.responseId)} /> : error && <ErrorLine>{error}</ErrorLine>}
    {/* The card's foot, one row, Details alone in the bottom-right corner: a decision has Ask me later and Drop this
        card; an update has Acknowledge and Show me later, then Comment beside Details. Drop, Acknowledge and the later
        times take the card away with the undo bar at the bottom. */}
    <div className="border-t border-border pt-2"><CardDetails card={entry.state.card} agent={entry.source.label}
      close={closed || stale ? undefined : info ? { kind: "acknowledge", onTap: () => foot.onClose("acknowledge") } : attention ? { kind: "drop", onTap: () => foot.onClose("drop") } : undefined}
      actions={<>
        {!info && saved && !asking && <button type="button" className={footActionClass} onClick={() => setFollowup(true)}>Change answer</button>}
        {followup && <button type="button" className={footActionClass} disabled={saving} onClick={() => { setFollowup(false); setText(""); setOwnOpen(false); }}>Keep my answer</button>}
        {foot.wake ?? ((info ? !closed : attention) && <button type="button" aria-expanded={later} onClick={() => setLater(!later)} className={footActionClass}>{laterWord}</button>)}
      </>}
      secondary={info && source.sendMessage ? <button type="button" aria-expanded={commenting} onClick={() => setCommenting(!commenting)} className={footActionClass}>Comment</button> : undefined}>
      <CardFacts entry={target} reference={reference} {...(priority !== undefined ? { priority } : {})} />
    </CardDetails></div>
    {later && <section aria-label={laterWord} className="space-y-2 rounded-xl border border-border p-3 text-sm"><p className="font-medium">{info ? "Show me again" : "Ask me again"}</p>
      <div className="flex flex-wrap gap-2">{snoozePresets(now).slice(0, 3).map((preset) => <button key={preset.id} type="button" onClick={() => { setLater(false); foot.onLater(preset.until); }} className={actionClass}>{preset.label}</button>)}</div>
    </section>}
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

type Row = { kind: "card"; item: HomeFeedEntry; retained?: boolean } | { kind: "group"; name: string; items: HomeFeedEntry[] };

/** `ask`: the tiny bots ask box, shown under the heading when the account has it. */
export function HomeFeedEntries({ source, ask }: { source: HomeFeedSource; ask?: ReactNode }) {
  useEffect(() => {
    void LazyAgentView.preload().catch(() => {});
    void LazyFilterPanel.preload().catch(() => {});
  }, []);
  const [snapshot, setSnapshot] = useState<HomeFeedSnapshot | null>(null);
  // Once the feed has loaded, the parts only a tap opens (a post's page, a brief) load too, so a tap never waits.
  const feedShown = snapshot !== null;
  useEffect(() => {
    if (!feedShown) return;
    LazyPostPage.preload().catch(() => {});
    LazyBriefSheet.preload().catch(() => {});
  }, [feedShown]);
  // Needs you | All, the saved default view (the retired Information view reads as All). No tab is chosen until the
  // saved one arrives, so the island never flips while loading.
  const [selector, setSelector] = useState<FeedSelector | null>(null);
  // History is the island's third tab; Snoozed, priority and order live in Filter. Both replace the view's list.
  const [history, setHistory] = useState(false);
  const [snoozedOnly, setSnoozedOnly] = useState(false);
  const [priorityMax, setPriorityMax] = useState("");
  const [sortBy, setSortBy] = useState<"" | "priority" | "due" | "expires">("");
  const [active, setActive] = useState<HomeFeedEntry | null>(null);
  const [sticky, setSticky] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // Cards opened in place, by lineage.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  // Needs you's first card, folded by the owner: it stays a row until the view changes.
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());
  // Answers not sent because the card was replaced during their countdown, by card key.
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Answers held when the page closed and settled at this launch, by card.
  const [heldOutcomes, setHeldOutcomes] = useState<ReadonlyMap<string, HeldAnswerOutcome>>(() => new Map());
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState("");
  const [project, setProject] = useState("");
  // Filter opens a popover under the row.
  const [panel, setPanel] = useState<"filter" | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  // The post whose page is open over the feed.
  const [pageKey, setPageKey] = useState<string | null>(null);
  const [error, setError] = useState<{ lead: string; text: string } | null>(null);
  const [viewBusy, setViewBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  // The agent view over the list: every agent ("list"), or one agent's page, by its agent key.
  const [agentPage, setAgentPage] = useState<string | null>(null);
  // The Pending card at the end of the list, open.
  const [pendingOpen, setPendingOpen] = useState(false);
  const chosenView = useRef(false);
  const hasDefault = useRef(false);
  const refreshRef = useRef<() => void>(() => {});
  const committed = useRef(new Map<string, FeedResponse>());
  const activeRef = useRef<HomeFeedEntry | null>(null);
  const currentSource = useRef(source);
  const pendingSends = useRef(new Set<() => void>());
  const ownDrafts = useRef(new Map<string, string>());
  currentSource.current = source;
  const mainRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const scrollTo = useRef<string | null>(null);
  // Drop this card, Acknowledge, Ask me later and Show me later take the card away at once; a bar at the bottom
  // counts the same 5 s as every send, with Undo, and only then is the action written (held in the outbox).
  const undoBar = useUndoBar((message) => setError({ lead: message, text: "Try again." }));
  // An open popover closes on a tap anywhere outside the toolbar and its popovers (Escape: onKeyDown below).
  useEffect(() => {
    if (!panel) return;
    const outside = (event: PointerEvent) => { if (!toolbarRef.current?.contains(event.target as Node)) setPanel(null); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [panel]);

  useEffect(() => {
    let alive = true;
    let running = false;
    let dirty = false;
    let loaded = false;
    let flushed = false;
    chosenView.current = false; hasDefault.current = false;
    committed.current.clear();
    activeRef.current = null;
    setSnapshot(null); setSelector(null); setActive(null); setError(null); setSticky(new Map()); setOpened(new Set()); setHeldOutcomes(new Map());
    setExpandedGroups(new Set()); setAgentPage(null); setPendingOpen(false); ownDrafts.current.clear();
    const refresh = async () => {
      if (running) { dirty = true; return; }
      running = true;
      do {
        dirty = false;
        try {
          const next = await source.load(activeRef.current ?? undefined, { feed: true });
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
          setSnapshot(next); setClock(Date.now()); setError(next.connectionError ? { lead: "You're offline.", text: "Live updates are off, so these cards may be out of date." } : null);
          markFeedFresh();
          if (!hasDefault.current && !chosenView.current) setSelector(next.settings.defaultSelector);
          hasDefault.current = true;
          // The first load registered the agents: answers held when the page last closed go now.
          if (!flushed && source.flushHeldAnswers) {
            flushed = true;
            void source.flushHeldAnswers().then((outcomes) => {
              if (!alive || !outcomes.length) return;
              setHeldOutcomes(new Map(outcomes.map((outcome) => [JSON.stringify([outcome.sourceId, outcome.cardId]), outcome])));
              // A replaced card's answer stays on screen with its refusal, as when a countdown is refused.
              const replaced = outcomes.find((outcome) => outcome.answered)?.answered;
              if (replaced) setActive(replaced);
              void refresh();
            }).catch(() => { /* Held answers stay held for the next launch. */ });
          }
        } catch {
          if (alive) setError({ lead: "Home didn't load.", text: "Check your connection, then try again." });
          markFeedFresh();
        }
      } while (alive && dirty);
      running = false;
    };
    refreshRef.current = () => { void refresh(); };
    // The device's last copy of the feed shows at once; the network load below
    // replaces it, reading every agent the copy names beside the registry. The
    // live-update stream opens beside it, and its first ready compares the
    // load's fingerprint instead of loading again.
    void (source.cached?.() ?? Promise.resolve(null)).then((local) => {
      if (!alive || loaded || !local) return;
      setSnapshot(local); setClock(Date.now());
      if (!hasDefault.current && !chosenView.current) setSelector(local.settings.defaultSelector);
    }).catch(() => {});
    const unsubscribe = source.subscribe(refreshRef.current);
    void refresh();
    return () => { alive = false; unsubscribe(); refreshRef.current = () => {}; };
  }, [source]);

  /**
   * The card's revisions, oldest first: those Home loaded as entries (with their owner history), and the rest of the
   * output's stored revisions, which carry no response, message or view.
   */
  const revisionsOf = (entry: HomeFeedEntry): HomeFeedEntry[] => {
    const known = new Map<number, HomeFeedEntry>();
    const candidates = [...(snapshot?.entries ?? []), ...(snapshot?.historicalEntries ?? []), ...(snapshot?.focusedEntry ? [snapshot.focusedEntry] : []), ...(active ? [active] : []), entry]
      .filter((candidate) => candidate.source.sourceId === entry.source.sourceId && candidate.state.card.cardId === entry.state.card.cardId);
    for (const candidate of candidates) known.set(candidate.state.card.revision, candidate);
    for (const card of candidates.flatMap((candidate) => candidate.earlierRevisions ?? [])) {
      if (!known.has(card.revision)) known.set(card.revision, storedRevisionEntry(entry.source, card));
    }
    return [...known.values()].sort((a, b) => a.state.card.revision - b.state.card.revision);
  };
  /**
   * A plain card's run of reply-only revisions ending at `entry`, oldest first: the revisions that differ from their
   * predecessor only by appended agent replies. Typed cards and any other change start a new run.
   */
  const replyChain = (entry: HomeFeedEntry): HomeFeedEntry[] => {
    if (isTypedPayload(entry)) return [entry];
    const chain = [entry];
    for (const previous of revisionsOf(entry).filter((candidate) => candidate.state.card.revision < entry.state.card.revision).reverse()) {
      if (!isReplyOnlyRevision(previous, chain[0]!)) break;
      chain.unshift(previous);
    }
    return chain;
  };
  /** One identity for a card across reply-only revisions: its drafts, countdowns and view state survive them. */
  const lineageKey = (entry: HomeFeedEntry) => keyOf(replyChain(entry)[0]!);
  /** The revision in the reply-only run that holds the stored answer, if any. */
  const answeredIn = (entry: HomeFeedEntry) => isTypedPayload(entry) ? undefined : [...replyChain(entry)].reverse().find((candidate) => candidate.state.response);
  /** Dropped or acknowledged by the owner, on any revision of the run (a reply-only revision doesn't reopen it). */
  const closureOf = (entry: HomeFeedEntry) => ownerClosure(replyChain(entry).flatMap((candidate) => candidate.responses ?? []));
  const all = [...new Map([...(snapshot?.entries ?? []), ...(snapshot?.historicalEntries ?? [])].map((entry) => [keyOf(entry), entry])).values()];
  // In History a revision that only gained agent replies is shown as its latest revision, once; so is a typed card its
  // agent closed: its earlier revisions (the one Sam answered or dropped among them) give way to the closing one.
  const replaces = (newer: HomeFeedEntry, older: HomeFeedEntry) => newer !== older && newer.state.card.revision > older.state.card.revision
    && (lineageKey(newer) === lineageKey(older) || (isTypedPayload(older) && newer.source.sourceId === older.source.sourceId && newer.state.card.cardId === older.state.card.cardId && closesRecord(newer)));
  const entries = history || snoozedOnly
    ? all.filter((entry) => !all.some((other) => replaces(other, entry)))
    : snapshot?.entries ?? [];
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
  // The clock moves on when something on screen changes with time: a snooze ends, a card expires or falls due.
  useEffect(() => {
    let next = Infinity;
    const consider = (value: number | undefined | null) => { if (value && value > clock) next = Math.min(next, value); };
    for (const entry of [...entries, ...(snapshot?.relatedEntries ?? []), ...(snapshot?.focusedEntry ? [snapshot.focusedEntry] : [])]) {
      consider(Date.parse(entry.view.snoozedUntil ?? ""));
      const timing = cardTiming(entry);
      consider(Date.parse(timing.expiresAt ?? ""));
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
  const view: Exclude<FeedSelector, "information"> = selector === "information" ? "both" : selector ?? "needs-action";
  const tab: FeedTab = history ? "history" : view;
  const timingOf = (entry: HomeFeedEntry) => cardTiming(entry, contextFor(entry));
  const expired = (entry: HomeFeedEntry) => { const at = timingOf(entry).expiresAt; return !!at && Date.parse(at) <= clock; };
  const matchesFilters = (entry: HomeFeedEntry) => (!agent || entry.source.sourceId === agent) && (!kind || kindOf(entry) === kind) && (!project || projectOf(entry) === project)
    && (!priorityMax || (timingOf(entry).priority ?? 9) <= Number(priorityMax));
  const attention = (entry: HomeFeedEntry) => needsAttention(entry, clock, contextFor(entry)?.projection) && !answeredIn(entry) && !closureOf(entry) && !expired(entry);
  const folded = (entry: HomeFeedEntry) => {
    const typed = contextFor(entry);
    if (!typed?.projection.foldedInto) return false;
    const parent = typed.entries.find((candidate) => { const context = contextFor(candidate); return context?.record.kind === "ask" && context.record.id === typed.projection.foldedInto?.id; });
    return !!parent && matchesFilters(parent) && attention(parent);
  };
  /**
   * A typed card its agent closed (answered, superseded, done, resolved…): it leaves the live views for History. Not
   * while it carries an answer of the owner's that was never sent: its "Not sent" line must be seen where it was given.
   */
  const agentClosed = (entry: HomeFeedEntry) => {
    const record = contextFor(entry)?.record;
    const held = heldOutcomes.get(JSON.stringify([entry.source.sourceId, entry.state.card.cardId]))?.outcome;
    return !!record && isClosed(record) && held !== "closed" && held !== "refused";
  };
  const inDone = (entry: HomeFeedEntry) => expired(entry) || !!closureOf(entry) || agentClosed(entry) || entry.state.card.payload?.sitrepThread !== undefined || !!entry.responses?.length || !!entry.state.response || !!answeredIn(entry) || !!entry.viewEvents?.some((event) => event.kind === "snoozed") || !!entry.owner?.answers.length || !!entry.owner?.claimDecisions.length || !!entry.owner?.threads.length || !!entry.owner?.outboundNotes?.length || !!entry.owner?.heldNotes?.length || !!entry.historicalCommands?.length || !!entry.owner?.states.some((state) => state.notes?.length || state.snoozes?.length || state.doneAt || state.dismissedAt || Object.keys(state.steps).length) || snoozedNow(entry, clock);
  // A card the owner touched in this view keeps its place, so an answer counting down (or a folded step he opened)
  // stays on screen. In All it stays, with "Change answer", until the view changes; in Needs you only until its
  // answer is saved, when it moves to Pending and the next card opens in its place.
  const keepsNeeds = (entry: HomeFeedEntry) => sticky.get(lineageKey(entry)) === true && (history || view !== "needs-action" || attention(entry));
  const needing = (entry: HomeFeedEntry) => (attention(entry) && !folded(entry)) || keepsNeeds(entry);
  const needsCount = (snapshot?.entries ?? []).filter((entry) => matchesFilters(entry) && attention(entry) && !folded(entry)).length;
  /**
   * Answered and still open (Sam, 11-13): Waiting on its agent, Answered (its agent got it), or Done (or Failed) and not
   * yet acknowledged. In Needs you and All these leave the main flow for the Pending card at its end, so only what needs
   * him stays in it. In All, a card he answered keeps its place until the view changes (keepsNeeds). A card its agent
   * closed is in History instead, whatever it reads.
   */
  const pendingStatus = (entry: HomeFeedEntry) => {
    const status = statusOf(entry, cardAuthor(entry, contextFor(entry)?.record).name);
    return status === "Done" || status === "Failed" || status === "Answered" || status?.startsWith("Waiting on") ? status : undefined;
  };
  const showsPending = !history && !snoozedOnly;
  const visible = (entry: HomeFeedEntry) => matchesFilters(entry) && !undoBar.hidden(lineageKey(entry));
  // A card whose answer was held when the page closed keeps its place this session, so its "sent" or "not sent" line shows.
  const heldHere = (entry: HomeFeedEntry) => heldOutcomes.has(JSON.stringify([entry.source.sourceId, entry.state.card.cardId]));
  const pendingEntries = showsPending ? entries.filter((entry) => visible(entry) && !snoozedNow(entry, clock) && !expired(entry) && !closureOf(entry) && !agentClosed(entry) && !attention(entry) && !keepsNeeds(entry) && !heldHere(entry) && !!pendingStatus(entry)).sort(compare) : [];
  const pendingKeys = new Set(pendingEntries.map(keyOf));
  const matching = entries.filter((entry) => {
    if (!visible(entry) || pendingKeys.has(keyOf(entry))) return false;
    // A snoozed card is out of every view until its time comes, except the Filter's "Snoozed" list.
    if (snoozedOnly) return snoozedNow(entry, clock);
    if (history) return inDone(entry);
    // Dropped, acknowledged, past its "matters until", or closed by its agent: only in History, marked so.
    if (snoozedNow(entry, clock) || expired(entry) || closureOf(entry) || agentClosed(entry)) return false;
    return view === "both" || needing(entry);
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
  const rows: Row[] = [...priority.priority, ...priority.rest];
  const activeKey = active ? keyOf(active) : null;
  let selected = entries.find((entry) => keyOf(entry) === activeKey)
    ?? (snapshot?.focusedEntry && keyOf(snapshot.focusedEntry) === activeKey ? snapshot.focusedEntry : active);
  // A card the owner is working on stays bound to its exact issuance when a newer one arrives: it keeps its place (in
  // place of its successor) until the owner moves on. A successor that only appends agent replies swaps in place.
  if (selected && !pendingKeys.has(keyOf(selected)) && !rows.some((row) => (row.kind === "card" ? [row.item] : row.items).some((entry) => keyOf(entry) === keyOf(selected!)))) {
    const current = selected;
    const successor = rows.findIndex((row) => row.kind === "card" && row.item.source.sourceId === current.source.sourceId && row.item.state.card.cardId === current.state.card.cardId);
    const next = successor >= 0 ? rows[successor] : undefined;
    if (next?.kind === "card" && !isTypedPayload(current) && isReplyOnlyRevision(current, next.item)) selected = next.item;
    else if (successor >= 0) rows[successor] = { kind: "card", item: current, retained: true };
    else if (!entries.some((entry) => keyOf(entry) === keyOf(current)) && !undoBar.hidden(lineageKey(current))) rows.unshift({ kind: "card", item: current, retained: true });
  }
  const selectedKey = selected ? keyOf(selected) : null;
  activeRef.current = selected ?? null;
  useEffect(() => { if (selected && activeKey && selectedKey !== activeKey) setActive(selected); }, [selectedKey, activeKey]);
  // Needs you: what needs you, by urgency, the first card open and raised. All: Needs you, Updates and Done today
  // (cards closed today), each as rows. History and Snoozed: newest first.
  const rowNeeds = (row: Row) => (row.kind === "card" ? [row.item] : row.items).some(needing);
  const newest = (row: Row) => Math.max(...(row.kind === "card" ? [row.item] : row.items).map((entry) => Date.parse(entry.state.card.createdAt)));
  // The Filter's order, when chosen: highest priority, soonest due, or soonest to expire first; cards without that
  // field go last, and ties keep the view's order.
  const sortValue = (row: Row) => Math.min(...(row.kind === "card" ? [row.item] : row.items).map((entry) => {
    const timing = timingOf(entry);
    return sortBy === "priority" ? timing.priority ?? 9 : sortBy === "due" ? Date.parse(timing.deadline ?? "") || Infinity : Date.parse(timing.expiresAt ?? "") || Infinity;
  }));
  const ordered = (list: Row[]) => sortBy ? [...list].sort((first, second) => sortValue(first) - sortValue(second)) : list;
  const day = new Date(clock).toDateString();
  const closedToday = (entry: HomeFeedEntry) => replyChain(entry).flatMap((candidate) => candidate.responses ?? []).some((response) => new Date(response.createdAt).toDateString() === day);
  const doneToday: Row[] = tab === "both" && !snoozedOnly
    ? all.filter((entry) => visible(entry) && !!closureOf(entry) && !all.some((other) => other !== entry && other.state.card.revision > entry.state.card.revision && lineageKey(other) === lineageKey(entry)) && closedToday(entry))
      .sort((a, b) => b.state.card.createdAt.localeCompare(a.state.card.createdAt)).map((item) => ({ kind: "card", item }))
    : [];
  const sections: [string, Row[]][] = tab === "needs-action" && !snoozedOnly
    ? [["", ordered(rows)]]
    : tab === "both" && !snoozedOnly
      ? [["Needs you", ordered(rows.filter(rowNeeds))], ["Updates", ordered(rows.filter((row) => !rowNeeds(row)))], ["Done today", doneToday]]
      : [["", ordered([...rows].sort((first, second) => newest(second) - newest(first)))]];
  // The cards in the order this view shows them, top to bottom (where focus goes when one is taken away), Pending last.
  const listed = sections.flatMap(([, list]) => list.flatMap((row) => row.kind === "card" ? [row.item] : row.items));
  const shown = [...listed, ...pendingEntries];
  // Needs you opens its first card (not a post, which has a page of its own) while no card in it is open and the owner
  // has folded none. The card it opens stays open (it joins `opened`), so cards moving around it never fold it; once
  // it is answered and leaves, the next card opens in its place.
  const firstOpen = tab === "needs-action" && !snoozedOnly && agentPage === null && !shut.size && !listed.some((entry) => opened.has(lineageKey(entry)))
    ? sections[0]?.[1].flatMap((row) => row.kind === "card" ? [row.item] : []).find((entry) => !labPageOf(entry)) : undefined;
  const firstOpenKey = firstOpen ? lineageKey(firstOpen) : null;
  useEffect(() => { if (firstOpenKey) setOpened((current) => current.has(firstOpenKey) ? current : new Set(current).add(firstOpenKey)); }, [firstOpenKey]);
  const isOpen = (entry: HomeFeedEntry) => opened.has(lineageKey(entry)) || lineageKey(entry) === firstOpenKey;

  // A card counts as seen once it shows open.
  const seenAsked = useRef(new Set<string>());
  const seenNow = shown.filter((entry) => (isOpen(entry) || lineageKey(entry) === pageKey) && !entry.view.seenAt && !seenAsked.current.has(keyOf(entry)));
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
  // Only the feed scrolls, never the page around it, and only when the opened card's top is out of view.
  useEffect(() => {
    const key = scrollTo.current, root = mainRef.current;
    if (!key || !root) return;
    scrollTo.current = null;
    const node = [...root.querySelectorAll<HTMLElement>("li[data-card-key]")].find((item) => item.dataset.cardKey === key);
    if (!node) return;
    const offset = node.getBoundingClientRect().top - root.getBoundingClientRect().top;
    if (offset < 0 || offset > root.clientHeight - 80) root.scrollTo({ top: root.scrollTop + offset - 16, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });

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
  /** Every change of what the list shows: answers still counting down are sent now (the owner chose them). */
  function leaveView() {
    for (const send of [...pendingSends.current]) send();
    setActive(null); setSticky(new Map()); setOpened(new Set()); setShut(new Set()); setAgentPage(null);
  }
  /**
   * A card line on an agent's page: back to the list with that card open in place. It opens where it lives: in the
   * Pending card, in All (without filters) if it is still in the feed, else in Snoozed or History.
   */
  function openFromAgent(entry: HomeFeedEntry) {
    leaveView();
    setAgent(""); setKind(""); setProject(""); setPriorityMax(""); setSortBy("");
    const inFeed = !snoozedNow(entry, clock) && !expired(entry) && !closureOf(entry);
    setHistory(!inFeed && !snoozedNow(entry, clock)); setSnoozedOnly(!inFeed && snoozedNow(entry, clock));
    if (inFeed && !attention(entry) && pendingStatus(entry)) setPendingOpen(true);
    // Showing All for this one tap does not change the saved default view.
    else if (inFeed && view === "needs-action" && !attention(entry)) { chosenView.current = true; setSelector("both"); }
    openCard(entry);
  }
  function changeSelector(next: FeedSelector) {
    if (next === view && !history && !snoozedOnly) return;
    leaveView();
    chosenView.current = true; setSelector(next); setHistory(false); setSnoozedOnly(false);
    // The last view is the next session's default; a failed write only loses that preference.
    if (snapshot?.settings.defaultSelector === next) return;
    setSnapshot((current) => current ? { ...current, settings: { defaultSelector: next } } : current);
    source.setDefaultSelector(next).catch(() => {});
  }
  function changeTab(next: FeedTab) {
    if (next !== "history") { changeSelector(next); return; }
    if (history && !snoozedOnly) return;
    leaveView(); setHistory(true); setSnoozedOnly(false);
  }
  function setFilter(update: () => void) { leaveView(); update(); }
  function engage(entry: HomeFeedEntry) {
    if (keyOf(entry) !== activeKey) setActive(entry);
    const key = lineageKey(entry);
    if (!sticky.has(key)) setSticky((current) => new Map(current).set(key, !history && attention(entry)));
  }
  /** Opens a card in place (in the compact view) and brings it into view. */
  function openCard(entry: HomeFeedEntry) {
    engage(entry);
    const key = lineageKey(entry);
    setOpened((current) => new Set(current).add(key));
    setShut((current) => { const next = new Set(current); next.delete(key); return next; });
    scrollTo.current = keyOf(entry);
  }
  function fold(entry: HomeFeedEntry) {
    const key = lineageKey(entry);
    setOpened((current) => { const next = new Set(current); next.delete(key); return next; });
    setShut((current) => new Set(current).add(key));
  }
  function release(entry: HomeFeedEntry) {
    const key = lineageKey(entry);
    setRefused((current) => { const next = new Map(current); next.delete(key); return next; });
    setHeldOutcomes((current) => { const next = new Map(current); next.delete(JSON.stringify([entry.source.sourceId, entry.state.card.cardId])); return next; });
    setSticky((current) => { const next = new Map(current); next.delete(key); return next; });
    if (keyOf(entry) === activeKey) setActive(null);
  }
  /**
   * Takes a card away now and shows the undo bar; `commit` runs once its 5 s pass (held in the outbox from then).
   * Focus moves to the card that takes its place, else the one above.
   */
  function takeAway(entry: HomeFeedEntry, text: string, commit: () => Promise<unknown>, undo?: () => void) {
    const key = lineageKey(entry);
    const index = shown.findIndex((candidate) => lineageKey(candidate) === key);
    const next = index < 0 ? undefined : shown[index + 1] ?? shown[index - 1];
    release(entry);
    // Shown again later (as a row in Done today or History), it is folded; Undo puts it back as it was.
    const wasOpen = isOpen(entry);
    setOpened((current) => { const remaining = new Set(current); remaining.delete(key); return remaining; });
    undoBar.push({ key, text, commit, undo: () => { if (wasOpen) setOpened((current) => new Set(current).add(key)); undo?.(); } });
    if (next) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(keyOf(next))}"] button`)?.focus());
  }
  /** The owner's card actions an agent hears about (card guide v2), written once the undo bar's count ends. */
  const tell = (entry: HomeFeedEntry, action: Parameters<NonNullable<HomeFeedSource["sendOwnerAction"]>>[1]) => async () => {
    if (!source.sendOwnerAction) return;
    await source.sendOwnerAction(entry, action, { hold: true });
    refreshRef.current();
  };
  /** Drop this card (a decision) or Acknowledge (an update): gone now, told to its agent and moved to History after the undo. */
  function closeCard(entry: HomeFeedEntry, kind: "drop" | "acknowledge") {
    const target = answeredIn(entry) ?? entry;
    takeAway(entry, kind === "drop" ? "Dropped" : "Acknowledged", tell(target, { type: kind === "drop" ? "feed.drop" : "feed.acknowledge" }));
  }
  /** Ask me later / Show me later on a plain card: saved, and its agent told, once the undo has passed. */
  function askLater(entry: HomeFeedEntry, until: string) {
    takeAway(entry, `Back at ${shortTime(until, clock)}`, async () => {
      await source.snooze(entry, until);
      setSnapshot((current) => updateSnapshotEntry(current, keyOf(entry), (candidate) => ({ ...candidate, view: { ...candidate.view, snoozedUntil: until } })));
      await tell(entry, { type: "feed.snooze", until })();
    });
  }
  /** A typed card's Ask me later saves its private snooze itself; the bar offers Undo, then tells the agent. */
  function snoozedTyped(entry: HomeFeedEntry, until: string) {
    takeAway(entry, `Back at ${shortTime(until, clock)}`, tell(entry, { type: "feed.snooze", until }), () => void unsnooze(entry));
  }
  /** Brings a snoozed card back now (the bar's Undo, or "Bring back now" from the Snoozed list). */
  async function unsnooze(entry: HomeFeedEntry) {
    const now = new Date(Date.now() - 1_000).toISOString();
    try {
      await source.snooze(entry, now);
      setSnapshot((current) => updateSnapshotEntry(current, keyOf(entry), (candidate) => ({ ...candidate, view: { ...candidate.view, snoozedUntil: now } })));
      refreshRef.current();
    } catch { setError({ lead: "That wasn't saved.", text: "Try again." }); }
  }

  async function saveGroup(entry: HomeFeedEntry, group: string, on: boolean) {
    setViewBusy(true); setError(null);
    try {
      if (!source.setGroupPriority) throw new Error("This feed source does not provide private group storage");
      await source.setGroupPriority(entry, group, on); refreshRef.current();
    } catch { setError({ lead: "That wasn't saved.", text: "Try again." }); }
    finally { setViewBusy(false); }
  }

  /** A card's status word, or how it left the feed: dropped, acknowledged or expired. */
  function statusOf(entry: HomeFeedEntry, author: string) {
    if (isTypedPayload(entry) && !contextFor(entry)) return undefined;
    return closureOf(entry) ?? (expired(entry) ? "Expired" : cardStatus(answeredIn(entry) ?? entry, contextFor(entry)?.projection, clock, author));
  }
  /** The agent's replies on a card, and how many came after the owner last opened it. */
  function repliesOf(entry: HomeFeedEntry): Replies | undefined {
    const context = contextFor(entry);
    if (context) return undefined;
    const theirs = plainConversation(entry, revisionsOf(entry).filter((candidate) => keyOf(candidate) !== keyOf(entry))).filter((line) => !line.mine);
    if (!theirs.length) return undefined;
    const seenAt = entry.view.seenAt;
    return { count: theirs.length, unread: theirs.filter((line) => !seenAt || line.at > seenAt).length, from: entry.source.label };
  }
  /** A card's one or two lines: what was chosen once it is answered, else its summary or body. */
  function describe(entry: HomeFeedEntry) {
    const until = entry.view.snoozedUntil;
    if (until && Date.parse(until) > clock) return `Back at ${shortTime(until, clock)}`;
    const response = (answeredIn(entry) ?? entry).state.response;
    if (response && !attention(entry)) {
      const label = response.choiceId ? entry.state.card.choices?.find((choice) => choice.id === response.choiceId)?.label : undefined;
      if (label) return `You chose ${optionText(label)}`;
      if (response.text) return `You answered “${response.text}”`;
    }
    return typeof entry.state.card.payload?.summary === "string" ? entry.state.card.payload.summary : entry.state.card.body;
  }
  const dueOf = (entry: HomeFeedEntry) => { const deadline = timingOf(entry).deadline; return deadline && attention(entry) ? deadline : undefined; };
  /** A card as a short item (compact view): its agent, title, short description and where it stands. Tap opens it. */
  function compactCard(entry: HomeFeedEntry) {
    const context = contextFor(entry);
    const author = cardAuthor(entry, context?.record).name;
    const due = dueOf(entry);
    const priority = timingOf(entry).priority;
    const replies = repliesOf(entry);
    const status = statusOf(entry, author);
    return <CompactCard agentKey={agentKey(entry, context?.record)} author={author} platform={agentProfile(entry.state.card.payload)?.platform} createdAt={entry.state.card.createdAt}
      title={entry.state.card.title} description={describe(entry)} now={clock} onOpen={() => openCard(entry)}
      {...(priority !== undefined ? { priority } : {})} {...(replies ? { replies } : {})} {...(status ? { status } : {})} {...(due ? { due } : {})} />;
  }
  /** A post: its row in the list, opening its page. */
  function postCard(entry: HomeFeedEntry) {
    const context = contextFor(entry);
    const author = cardAuthor(entry, context?.record).name;
    const page = labPageOf(entry)!;
    const status = postStatus(entry, page, statusOf(entry, author) ?? "", answeredIn(entry));
    return <PostPreview entry={entry} page={page} author={author} agentKey={agentKey(entry, context?.record)} onOpen={() => { engage(entry); setPageKey(lineageKey(entry)); }}
      {...(agentProfile(entry.state.card.payload)?.platform ? { platform: agentProfile(entry.state.card.payload)!.platform } : {})} {...(status ? { status } : {})} />;
  }
  /** A card open: its header, body, brief, answers, conversation and foot, with the page's refusal lines. */
  function fullCard(entry: HomeFeedEntry, retained = false) {
    const key = lineageKey(entry);
    const held = heldOutcomes.get(JSON.stringify([entry.source.sourceId, entry.state.card.cardId]));
    const heldLabel = held?.choiceLabel ? optionText(held.choiceLabel) : NOT_SENT_COPY.yourAnswer;
    const refusedLabel = refused.get(key) ?? (retained && held?.answered && keyOf(held.answered) === keyOf(entry) ? heldLabel : undefined);
    const onRefused = (label: string) => setRefused((current) => new Map(current).set(key, label));
    const context = contextFor(entry);
    const unsupported = isTypedPayload(entry) && !context;
    const author = cardAuthor(entry, context?.record);
    const reference = <Reference title={homeFeedKey(entry)}>{humanFeedReference(entry, entries)}</Reference>;
    const brief = briefOf(entry.state.card.payload);
    const priority = timingOf(entry).priority;
    const closed = !!closureOf(entry);
    // Open in place: fold it back to a row from the top right, beside its status.
    const collapse = <button type="button" aria-expanded aria-label="Show less" onClick={() => fold(entry)} className="-my-1 flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:my-0 fine:size-9"><ChevronRightIcon aria-hidden className="size-4 -rotate-90" /></button>;
    const wake = snoozedNow(entry, clock) ? <button type="button" onClick={() => void unsnooze(entry)} className={footActionClass}>Bring back now</button> : undefined;
    const status = statusOf(entry, author.name);
    // Any touch or focus inside an open card engages it, in every view: a card being answered stays bound to its exact
    // issuance (retained in place when a changed revision arrives mid-countdown, so the countdown is refused, never
    // written to the old identity).
    return <div className="min-w-0" onPointerDownCapture={() => engage(entry)} onFocusCapture={() => engage(entry)}><HomeCardView card={cardView(entry, context)} sample={false} readBody={source.readBody} agent={{ key: agentKey(entry, context?.record), profile: agentProfile(entry.state.card.payload) }}
      {...(unsupported ? {} : { onAuthor: () => { leaveView(); setAgentPage(agentKey(entry, context?.record)); mainRef.current?.scrollTo({ top: 0 }); } })}
      {...(status ? { status } : {})} collapse={collapse}>
      {retained && <div role={refusedLabel ? "alert" : "status"} className="mt-3 flex flex-wrap items-center gap-x-3 text-[13px] text-muted-foreground"><span>{refusedLabel
        ? <NotSent label={refusedLabel} changed />
        : "A newer version of this card arrived. Answer it there; your draft stays here."}</span><button type="button" className={quietClass} onClick={() => release(entry)}>Show the newer version</button></div>}
      {!retained && held?.outcome === "sent" && <p role="status" className="mt-3 text-[13px] text-muted-foreground">{HELD_ANSWER_COPY.sent}</p>}
      {!retained && (held?.outcome === "closed" || held?.outcome === "refused") && <p role="alert" className="mt-3 text-[13px]"><NotSent label={heldLabel} /></p>}
      {/* The agent's one-page brief, read in the app beside the decision. */}
      {brief && <BriefButton brief={brief} className="mt-3" />}
      <ReportLink entry={entry} />
      {context
        ? <SitrepCard key={key} entry={entry} record={context.record} records={context.records} entries={context.entries} owner={context.owner} projection={context.projection} source={source} now={clock} expanded stale={retained} reference={reference}
          onRefused={onRefused} onSaved={onSaved} onOwnerSaved={() => refreshRef.current()} onSnoozed={(until) => snoozedTyped(entry, until)}
          onNavigate={(next) => { engage(next); setOpened((current) => new Set(current).add(lineageKey(next))); }}
          {...(attention(entry) && !retained ? { close: { kind: "drop" as const, onTap: () => closeCard(entry, "drop") } } : {})} {...(wake ? { extra: wake } : {})} />
        : unsupported
          ? <><p role="status" className="mt-3.5 text-sm text-muted-foreground">Open Details to see this card's content, exactly as {author.name} sent it.</p>
            <div className="mt-3 border-t border-border pt-2"><CardDetails card={entry.state.card} typed={{}} agent={author.name}>
              <CardFacts entry={entry} reference={reference} {...(priority !== undefined ? { priority } : {})} />
            </CardDetails></div></>
          : <AnswerForm key={key} drafts={ownDrafts.current} draftKey={key} entry={entry} answered={answeredIn(entry)} onRefused={onRefused} revisions={revisionsOf(entry).filter((candidate) => keyOf(candidate) !== keyOf(entry))} source={source} now={clock}
            attention={attention(entry)} closed={closed} stale={retained} reference={reference} onSaved={onSaved} {...(priority !== undefined ? { priority } : {})}
            foot={{ onClose: (kind) => closeCard(entry, kind), onLater: (until) => askLater(entry, until), ...(wake ? { wake } : {}) }} />}
    </HomeCardView></div>;
  }
  /** A card in the list: a row, or open in place (Needs you's first card is open). A post is a row opening its page. */
  const cardItem = (entry: HomeFeedEntry, retained = false) => {
    const key = lineageKey(entry);
    const page = labPageOf(entry);
    // Each card morphs between a row and its open shape as one item: its box moves and resizes while its content
    // crossfades (densityMorph.tsx).
    return <MorphItem key={key} contentKey={page ? "post" : isOpen(entry) || retained ? "full" : "compact"} data-card-key={keyOf(entry)} className="min-w-0 scroll-mt-4">
      {page ? postCard(entry) : isOpen(entry) || retained ? fullCard(entry, retained) : compactCard(entry)}
      {/* The Snoozed list: each card can come back now without opening it. */}
      {snoozedOnly && !isOpen(entry) && snoozedNow(entry, clock) && <div className="flex justify-end px-2 pb-2"><button type="button" onClick={() => void unsnooze(entry)} className={footActionClass}>Bring back now</button></div>}
    </MorphItem>;
  };
  const asRow = (row: Row) => row.kind === "card" && !row.retained && (!!labPageOf(row.item) || !isOpen(row.item));
  /** A section's items: open cards and groups on their own, and each run of rows together in one bordered list. */
  function renderList(list: Row[]) {
    const out: ReactNode[] = [];
    let run: ReactNode[] = [];
    const flush = () => {
      if (!run.length) return;
      out.push(<li key={`rows-${out.length}`} className="min-w-0"><ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">{run}</ul></li>);
      run = [];
    };
    for (const row of list) {
      if (asRow(row)) run.push(renderRow(row));
      else { flush(); out.push(renderRow(row)); }
    }
    flush();
    return out;
  }
  function renderRow(row: Row) {
    if (row.kind === "card") return cardItem(row.item, row.retained);
    const first = row.items[0]; const record = first && contextFor(first)?.record; const name = record && cardGroup(record);
    if (!first || !name) throw new Error("Invalid grouped Home card");
    const open = expandedGroups.has(row.name);
    const pinned = groupPriorityFlag(contextFor(first)?.owner.groupPriority?.groups[name], row.items.map((entry) => { const context = contextFor(entry); return !!context && !!cardPriority(context.record, context.projection.state?.priority); }));
    return <li key={row.name} className="min-w-0"><section aria-label={`Card group ${name}`} className="py-1">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="flex min-h-12 grow items-center gap-2 px-1 text-left text-sm font-medium" aria-expanded={open} onClick={() => setExpandedGroups((previous) => { const next = new Set(previous); if (next.has(row.name)) next.delete(row.name); else next.add(row.name); return next; })}><ChevronRightIcon aria-hidden className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />{name} · {row.items.length} cards</button>
        <button type="button" disabled={viewBusy} aria-pressed={pinned} className={quietClass} onClick={() => void saveGroup(first, name, !pinned)}>{pinned ? "Clear priority" : "Mark priority"}</button>
      </div>
      {open && <ul className="space-y-2 pl-3">{renderList(row.items.map((item): Row => ({ kind: "card", item })))}</ul>}
    </section></li>;
  }

  const agents = [...new Map((snapshot?.entries ?? []).map((entry) => [entry.source.sourceId, entry.source.label])).entries()];
  const projects = [...new Set((snapshot?.entries ?? []).map(projectOf).filter(Boolean))].sort();
  const kinds = [...new Set((snapshot?.entries ?? []).map(kindOf))].sort();
  const filtersOn = [agent, kind, project, priorityMax, sortBy].filter(Boolean).length + (snoozedOnly ? 1 : 0);
  const today = (snapshot?.entries ?? []).filter((entry) => !attention(entry) && new Date(entry.state.card.createdAt).toDateString() === new Date(clock).toDateString()).length;
  // Home shows only the heading and its empty card until the first card arrives; while loading, the controls are
  // already in place so nothing moves when cards land.
  const bare = !!snapshot && !snapshot.entries.length && !snapshot.historicalEntries?.length;
  // The agents on the Agents pill: one mark per agent (connection and crew member), newest card first.
  const pillAgents = [...new Map([...(snapshot?.entries ?? [])].sort((a, b) => b.state.card.createdAt.localeCompare(a.state.card.createdAt)).map((entry) => {
    const record = contextFor(entry)?.record;
    return [agentKey(entry, record), { key: agentKey(entry, record), name: cardAuthor(entry, record).name }] as const;
  })).values()];
  const unreadReplies = (snapshot?.entries ?? []).some((entry) => (repliesOf(entry)?.unread ?? 0) > 0);
  const pageEntry = pageKey ? all.find((entry) => lineageKey(entry) === pageKey && !all.some((other) => other !== entry && other.state.card.revision > entry.state.card.revision && lineageKey(other) === pageKey)) : undefined;
  const pageOpen = pageEntry && labPageOf(pageEntry);
  const clearFilters = () => setFilter(() => { setAgent(""); setKind(""); setProject(""); setPriorityMax(""); setSortBy(""); setSnoozedOnly(false); });
  // While undo bars show, the scroll container itself grows at its end by their height, their offset from the bottom
  // edge and the safe-area inset, so its last cards can scroll clear of them (Clarissa, 75eebec).
  return <PendingSendContext.Provider value={pendingSends.current}><MotionFeatures><main ref={mainRef} className="h-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-y-contain bg-background text-foreground [overflow-anchor:none]" aria-label={NAV_LABEL_HOME}
    style={undoBar.height ? { paddingBottom: `calc(${undoBar.height + 32}px + env(safe-area-inset-bottom))` } : undefined}>
    <div className="mx-auto w-full max-w-[672px] min-w-0 px-3 pb-[calc(var(--tc-bottom-chrome)+2rem)] pt-5 sm:px-6 lg:px-8 lg:pt-10" inert={!!pageEntry}>
    <MorphConfig>
      {/* Sam, 11-13: one header for every state, phone and desktop (briefs/feed-lab/design/toprow). "Home" with the
          Agents pill on its line, the summary, then one row: Needs you · All · History, and the Filter icon. Scrolled,
          the row stays at the top over the cards; the title comes back on scroll up. */}
      <FloatingHeader scrollRef={mainRef} className="-mx-3 mb-3 px-3 pb-2 pt-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <header ref={headerRef} className="scroll-mt-4">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 flex-1 font-display text-[min(1.75rem,9vw)] font-semibold leading-[2.125rem] tracking-[-0.005em]">{NAV_LABEL_HOME}</h1>
            {!bare && pillAgents.length > 0 && <AgentsPill agents={pillAgents} unread={unreadReplies} open={agentPage !== null}
              onOpen={() => { if (agentPage !== null) { setAgentPage(null); return; } leaveView(); setAgentPage("list"); }} />}
          </div>
          <p className="mt-0.5 text-sm leading-[1.45] text-muted-foreground">{snapshot && !bare
            ? <>{needsCount ? <b className="font-semibold text-foreground">{needsCount} {needsCount === 1 ? "needs" : "need"} you.</b> : <b className="font-semibold text-foreground">Nothing needs you.</b>}{today > 0 && ` ${today} ${today === 1 ? "update" : "updates"} today.`}</>
            : "Updates and decisions from your agents."}</p>
        </header>
        {/* Filter opens a popover over the cards, so the list never moves under it (QA cb784d4, B1/P5). */}
        {!bare && <div ref={toolbarRef} data-float-keep data-float-pin className="relative mt-3.5 flex min-w-0 items-center gap-1.5" onKeyDown={(event) => {
          if (event.key !== "Escape" || !panel) return;
          event.preventDefault();
          setPanel(null);
          filterButton.current?.focus();
        }}>
          <FeedTabs className="min-w-0 flex-1" value={tab} needs={needsCount} onValueChange={changeTab} />
          <button ref={filterButton} type="button" aria-expanded={panel === "filter"} aria-controls="home-feed-filters" aria-label={filtersOn ? `Filter, ${filtersOn} on` : undefined} onClick={() => setPanel(panel === "filter" ? null : "filter")}
            className={`relative flex size-11 shrink-0 items-center justify-center rounded-full border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${filtersOn ? "border-foreground bg-foreground/[.06]" : "border-border"}`}>
            <SlidersHorizontalIcon aria-hidden className="size-5" /><span className="sr-only">Filter</span>
            {!!filtersOn && <span aria-hidden className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-foreground px-1 text-[11px] font-bold text-background ring-2 ring-background">{filtersOn}</span>}
          </button>
          {/* Sam, 11-13: the dropdowns on top; Snoozed and Clear under them (History is a tab). */}
          {panel === "filter" && <LazyFilterPanel agents={agents} agent={agent} kinds={kinds} kind={kind} projects={projects} project={project}
            priorityMax={priorityMax} sortBy={sortBy} snoozedOnly={snoozedOnly} filtersOn={filtersOn} setFilter={setFilter}
            setAgent={setAgent} setKind={setKind} setProject={setProject} setPriorityMax={setPriorityMax} setSortBy={setSortBy}
            setSnoozedOnly={setSnoozedOnly} setHistory={setHistory} clearFilters={clearFilters} />}
        </div>}
      </FloatingHeader>
      {ask}
      {error && <div role="alert" className="mb-4 flex items-start gap-3 rounded-2xl bg-card px-4 py-3 text-sm leading-[1.45] shadow-[inset_0_0_0_1px_hsl(var(--border))]">
        <TriangleAlertIcon aria-hidden className="mt-px size-5 shrink-0 text-warning" />
        <div className="min-w-0"><p><b className="font-semibold">{error.lead}</b> {error.text}</p><button type="button" onClick={() => refreshRef.current()} className="mt-2 min-h-11 underline">Try again</button></div>
      </div>}
      {!snapshot && !error && <ul aria-busy="true" aria-label="Loading your feed" className="grid gap-3">
        {[0, 1, 2].map((index) => <li key={index} aria-hidden className={`${cardClass} space-y-3`}>
          <div className="flex items-center gap-2"><span className="size-7 rounded-full bg-muted" /><span className="h-3 w-2/5 rounded-full bg-muted" /></div>
          <div className="h-3.5 w-4/5 rounded-full bg-muted" />
          <div className="h-3.5 w-3/5 rounded-full bg-muted" />
        </li>)}
      </ul>}
      {snapshot && agentPage !== null && <LazyAgentView entries={all} page={agentPage} contextFor={contextFor} author={cardAuthor}
        agentKey={agentKey} lineageKey={lineageKey} needsYou={(entry) => attention(entry) && !folded(entry)}
        unread={(entry) => repliesOf(entry)?.unread ?? 0} now={clock} onPage={setAgentPage} onOpenCard={openFromAgent} />}
      {snapshot && agentPage === null && !listed.length && (bare
        ? <section aria-labelledby="home-empty-title" className={cardClass}>
          <h2 id="home-empty-title" className="font-display text-[1.375rem] font-normal leading-[1.2]">{HOME_EMPTY_TITLE}</h2>
          <p className="mt-2 max-w-[60ch] text-base leading-[1.5]">{HOME_EMPTY_BODY}</p>
          <Link to={PATHS.chat} className={primaryPillClass}>{HOME_EMPTY_CHAT}</Link>
          <AgentPrompt copyButton={({ onClick, children }) => <button type="button" className={primaryPillClass} onClick={onClick}>{children}</button>}
            aside={<a href={FEED_SKILL_URL} target="_blank" rel="noopener noreferrer" className={quietClass}>{HOME_EMPTY_HOW}</a>} />
        </section>
        : <div className="mb-4 rounded-[20px] px-[18px] py-4 text-[15px] text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]">
          <p>{snoozedOnly ? "No snoozed cards." : history ? "Nothing answered or snoozed yet." : filtersOn ? "No cards match this filter." : view === "needs-action" ? "Nothing needs you." : "No cards yet."}</p>
          {!!filtersOn && <button type="button" className="mt-2 inline-flex min-h-11 items-center rounded-xl border border-border px-3 text-sm text-foreground" onClick={clearFilters}>Clear filter</button>}
        </div>)}
      {agentPage === null && !!listed.length && <div className="mb-4 space-y-6">
        {sections.map(([heading, list]) => !!list.length && <section key={heading || "cards"} aria-label={heading || (history ? "History" : snoozedOnly ? "Snoozed" : "Cards")}>
          {heading && <h2 className="mb-2 flex items-baseline justify-between px-1 text-label font-semibold uppercase tracking-[0.06em] text-muted-foreground"><span>{heading}</span><span className="tabular-nums">{list.reduce((count, row) => count + (row.kind === "card" ? 1 : row.items.length), 0)}</span></h2>}
          <ul className="space-y-2">{renderList(list)}</ul>
        </section>)}
      </div>}
      {agentPage === null && !!pendingEntries.length && <div className="mb-4"><PendingCard expanded={pendingOpen} onToggle={() => setPendingOpen(!pendingOpen)} items={pendingEntries.map((entry): PendingItem => {
        const record = contextFor(entry)?.record;
        const author = cardAuthor(entry, record).name;
        const status = pendingStatus(entry)!;
        return { key: keyOf(entry), agentKey: agentKey(entry, record), author, title: entry.state.card.title, status, detail: describe(entry), at: (answeredIn(entry) ?? entry).state.response?.createdAt ?? entry.state.card.createdAt,
          onOpen: () => openCard(entry), ...(opened.has(lineageKey(entry)) ? { open: fullCard(entry) } : {}),
          ...(status.startsWith("Waiting") ? {} : { onAcknowledge: () => closeCard(entry, "acknowledge") }) };
      })} /></div>}
    </MorphConfig>
    {undoBar.bar}
    </div>
    {pageEntry && pageOpen && (() => {
      const author = cardAuthor(pageEntry).name;
      const status = statusOf(pageEntry, author);
      return <LazyPostPage key={pageKey} entry={pageEntry} answered={answeredIn(pageEntry)} page={pageOpen} source={source} author={author} onSaved={onSaved} onClose={() => setPageKey(null)}
        onRefused={(label) => setRefused((current) => new Map(current).set(lineageKey(pageEntry), label))}
        card={(children) => <HomeCardView plain card={cardView(pageEntry)} sample={false} readBody={source.readBody} agent={{ key: agentKey(pageEntry), profile: agentProfile(pageEntry.state.card.payload) }} {...(status ? { status } : {})}>{children}</HomeCardView>}
        status={(answeredIn(pageEntry) ?? pageEntry).state.response ? <ResponseStatus entry={answeredIn(pageEntry) ?? pageEntry} focusOnMount={false} /> : null}
        footer={<CardConversation lines={plainConversation(pageEntry, revisionsOf(pageEntry).filter((candidate) => keyOf(candidate) !== keyOf(pageEntry)))} to={source.sendMessage ? pageEntry.source.label : undefined}
          onSend={async (text) => {
            if (!source.sendMessage) return false;
            const card = pageEntry.state.card;
            try { onSaved(pageEntry, await source.sendMessage(pageEntry, { responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, kind: "message", text, createdAt: new Date().toISOString() })); return true; }
            catch { return false; }
          }} />} />;
    })()}
  </main></MotionFeatures></PendingSendContext.Provider>;
}
