import { Link } from "react-router-dom";
import { PATHS } from "@/shell/routes";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon, SlidersHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import type { FeedResponse, FeedSelector, NewFeedMessage, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { FeedCardView } from "./FeedView";
import { safeUrl, type FeedCard } from "./feedData";
import type { HeldAnswerOutcome, HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { SitrepCard } from "./SitrepCard";
import { typedContexts, type TypedCardContext } from "./sitrepProjection";
import { humanFeedReference, homeFeedKey, homeGroupScope } from "./feedIdentity";
import { threadSize, ThreadView, typedCommentItems, type ThreadItem } from "./HomeCardThread";
import { isReplyOnlyRevision, storedRevisionEntry } from "./replyOnlyRevision";
import { AnsweredPanel, AnswerFailedLine, cardClass, COMMENT_COPY, commentCopy, cardTime, chipClass, dueTime, ErrorLine, fieldClass, focusRing, HELD_ANSWER_COPY, NOT_SENT_COPY, NotSent, kindWord, MoreSheet, OptionButtons, optionText, PendingAnswer, PendingSendContext, pillClass, primaryPillClass, QuietRow, quietClass, Reference, SheetSection, SnoozeChoices, usePendingSend } from "./cardKit";
import { cardGroup, cardPriority, compareWaiting, DUE_WINDOW_MS, groupCards, groupPriorityFlag, isClosed, orderPriority, type SitrepProjection } from "@tinyboilerplate/core/feed/sitrep";
import { HOME_EMPTY_BODY, HOME_EMPTY_CHAT, HOME_EMPTY_HOW, HOME_EMPTY_TITLE, NAV_LABEL_HOME } from "@/lib/homeStrings";
import { AgentPrompt } from "@/home/AgentPromptCard";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import { FEED_SKILL_URL } from "./strings";
import { AgentMark, agentKey, agentProfile, cardAuthor } from "./AgentMark";
import { AnswerSteps } from "./AnswerSteps";
import { AgentConversation, AgentList, agentThreads } from "./AgentPage";
import { changedFlags, useFeedFlags } from "./feedFlags";

type HomeView = "needs-you" | "all" | "done";
const VIEWS: readonly { id: HomeView; label: string }[] = [{ id: "needs-you", label: "Needs you" }, { id: "all", label: "All" }, { id: "done", label: "History" }];

function keyOf(entry: HomeFeedEntry): string {
  const card = entry.state.card;
  return JSON.stringify([entry.source.sourceId, card.cardId, card.revision, card.issuanceId]);
}
function isTypedPayload(entry: HomeFeedEntry): boolean {
  return entry.state.card.payload?.sitrep !== undefined || entry.state.card.payload?.sitrepThread !== undefined;
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
function cardView(entry: HomeFeedEntry, context?: TypedCardContext): FeedCard {
  const card = entry.state.card;
  const payload = card.payload ?? {};
  const render = ["post", "image", "thread", "article", "link"].includes(String(payload.render)) ? payload.render as FeedCard["render"] : "post";
  const source = payload.source;
  const sourceRecord = source && typeof source === "object" ? source as Record<string, unknown> : undefined;
  return {
    key: keyOf(entry), at: card.createdAt, author: { name: cardAuthor(entry, context?.record).name }, render,
    title: card.title, lead: { text: card.body, ...(typeof payload.image === "string" ? { image: payload.image } : {}) },
    // Replies on a plain card render in its conversation (plainThreadItems), not in the body.
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
  return <a href={url} target="_blank" rel="noopener noreferrer" className={`mt-0.5 inline-flex min-h-11 max-w-full items-center break-all text-sm underline underline-offset-[3px] ${focusRing}`}>{typeof label === "string" ? label : "Full report"}</a>;
}

function CardHistory({ entry, now }: { entry: HomeFeedEntry; now: number }) {
  const responses = entry.responses ?? (entry.state.response ? [entry.state.response] : []);
  const snoozes = entry.viewEvents?.filter((event) => event.kind === "snoozed") ?? [];
  if (!responses.length && !snoozes.length) return null;
  return <SheetSection title="History">
    <ol className="space-y-3 text-sm">
      {responses.map((response) => <li key={response.responseId} className="break-words">
        <p className="text-[13px] text-muted-foreground">{response.kind === "message" ? "Message saved" : response.kind === "followup" ? "Changed answer" : "Answer saved"} · <time dateTime={response.createdAt}>{cardTime(response.createdAt, now)}</time></p>
        {response.choiceId && <p>{optionText(entry.state.card.choices?.find((choice) => choice.id === response.choiceId)?.label ?? "An option that is no longer listed")}</p>}
        {response.text && <p className="whitespace-pre-wrap">{response.text}</p>}
      </li>)}
      {snoozes.map((event) => <li key={`snooze-${event.sequence}`} className="text-[13px] text-muted-foreground">Asked to see it later · {cardTime(event.createdAt, now)}{event.snoozedUntil && `, until ${dueTime(event.snoozedUntil, now)}`}</li>)}
    </ol>
  </SheetSection>;
}

/** The saved answer in words: the option label, never its id; "got it" only once the agent acknowledged. Its steps follow. */
function ResponseStatus({ entry, now, focusOnMount }: { entry: HomeFeedEntry; now: number; focusOnMount: boolean }) {
  const { response, acknowledgement, outcome } = entry.state;
  if (!response) return null;
  const agent = entry.source.label;
  const received = acknowledgement?.responseId === response.responseId ? acknowledgement : null;
  const result = outcome?.responseId === response.responseId ? outcome : null;
  const detail = result?.detail?.message;
  const choice = response.choiceId ? entry.state.card.choices?.find((option) => option.id === response.choiceId) : undefined;
  const label = choice && optionText(choice.label);
  return <AnsweredPanel focusOnMount={focusOnMount}>
    <p>{label ? <>You chose <b className="font-semibold">{label}</b>.</> : "You answered."}{received && ` ${agent} got it.`}{result && (result.phase === "succeeded" ? ` ${agent} finished it.` : ` ${agent} couldn't finish it.`)}</p>
    {response.text && <p className="whitespace-pre-wrap">{response.text}</p>}
    {typeof detail === "string" && <p className="whitespace-pre-wrap">{detail}</p>}
    <AnswerSteps sent={response.createdAt} acknowledgement={received} outcome={result} agent={agent} now={now} />
  </AnsweredPanel>;
}

/**
 * A plain card's conversation: the owner's messages on every revision of the card, and the
 * agent's `payload.replies`, each timed by the first revision that carried it. Replies are
 * append-only, so reply i first appears in the earliest revision with more than i replies.
 */
function plainThreadItems(entry: HomeFeedEntry, revisions: readonly HomeFeedEntry[]): ThreadItem[] {
  const agent = entry.source.label;
  const upTo = [...revisions, entry].filter((candidate) => candidate.state.card.revision <= entry.state.card.revision)
    .sort((a, b) => a.state.card.revision - b.state.card.revision);
  const items: ThreadItem[] = [];
  const seen = new Set<string>();
  let replies = 0;
  for (const revision of upTo) {
    for (const message of revision.responses ?? []) {
      if (message.kind !== "message" || !message.text || seen.has(message.responseId)) continue;
      seen.add(message.responseId);
      items.push({ key: `message:${message.responseId}`, id: message.responseId, at: message.createdAt, speaker: COMMENT_COPY.you, text: message.text, mine: true,
        ...(revision.responseHandling?.[message.responseId]?.acknowledgement ? { status: <span>{agent} got it</span> } : {}) });
    }
    const payload = revision.state.card.payload;
    const list = payload?.render === "thread" && Array.isArray(payload.replies) ? payload.replies.filter((reply): reply is { text: string } => !!reply && typeof reply === "object" && "text" in reply && typeof reply.text === "string") : [];
    for (let index = replies; index < list.length; index++) items.push({ key: `reply:${index}`, id: `reply:${index}`, at: revision.state.card.createdAt, speaker: agent, text: list[index]!.text, mine: false });
    replies = Math.max(replies, list.length);
  }
  return items;
}

/** An untyped card's answer and conversation: one tap on an option, or an answer in words, sent after a short undo window. */
function AnswerForm({ entry, answered, revisions, source, now, attention, expanded, reference, stale = false, onRefused, onSaved, onSnooze }: {
  entry: HomeFeedEntry; source: HomeFeedSource; now: number; attention: boolean; expanded: boolean; reference: ReactNode;
  /**
   * The revision that holds the card's stored answer, when an earlier revision was answered and
   * only agent replies followed. The answer stays bound to that issuance: it is shown on this
   * card, and a follow-up to it still names that issuance.
   */
  answered?: HomeFeedEntry;
  /** The card's other revisions Home holds (for its conversation). */
  revisions: readonly HomeFeedEntry[];
  /** A newer issuance replaced this card: its draft stays, but it can no longer be answered. */
  stale?: boolean;
  /** An answer whose countdown ended after the card was replaced: nothing was written. */
  onRefused: (label: string) => void;
  onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void;
  onSnooze: (entry: HomeFeedEntry, until: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The answer whose send failed: whether it is still held is read when the line renders.
  const [failed, setFailed] = useState<{ target: HomeFeedEntry; responseId: string } | null>(null);
  const [followup, setFollowup] = useState(false);
  const [later, setLater] = useState(false);
  const [more, setMore] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const countdown = usePendingSend({ stale, onRefused });
  const { captions } = useFeedFlags();
  const [composing, setComposing] = useState(false);
  const [messaging, setMessaging] = useState(false);
  const pendingResponse = useRef<{ key: string; response: NewFeedResponse } | null>(null);
  const pendingMessage = useRef<{ text: string; message: NewFeedMessage } | null>(null);
  const card = entry.state.card;
  const choices = card.choices ?? [];
  // Writes go to the answered issuance when there is one, otherwise to the card as it is now.
  const target = answered ?? entry;
  const saved = target.state.response;
  // Read when a countdown commits, so an answer re-targets to a reply-only revision that arrived meanwhile.
  const live = useRef({ target, saved, text });
  live.current = { target, saved, text };
  async function save(choice?: string) {
    const { target, saved, text } = live.current;
    if (saving || (!text.trim() && !choice)) return;
    setSaving(choice ?? "text"); setError(null); setFailed(null);
    const card = target.state.card;
    // Retain the response identity across a failed/ambiguous write. A retry of
    // the same answer to the same issuance cannot create a second one.
    const key = JSON.stringify([card.cardId, card.revision, card.issuanceId, choice ?? null, text.trim()]);
    const response = pendingResponse.current?.key === key ? pendingResponse.current.response : {
      responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
      kind: saved ? "followup" as const : "answer" as const,
      ...(choice ? { choiceId: choice } : {}), ...(text.trim() ? { text: text.trim() } : {}),
      ...(saved ? { supersedesResponseId: saved.responseId } : {}), createdAt: new Date().toISOString(),
    };
    pendingResponse.current = { key, response };
    try {
      // Held until confirmed: a page that closes before this write lands sends it at the next launch.
      const result = await source.saveResponse(target, response, undefined, { hold: true });
      onSaved(target, result);
      pendingResponse.current = null;
      setText(""); setNoteOpen(false); setFollowup(false); setJustSaved(true);
    } catch {
      setFailed({ target, responseId: response.responseId });
    } finally { setSaving(null); }
  }
  /** A card message to the publishing agent (the existing card-message path). A retry reuses its id. */
  async function message(value: string): Promise<boolean> {
    if (!source.sendMessage || messaging) return false;
    setMessaging(true); setError(null);
    const draft = pendingMessage.current?.text === value ? pendingMessage.current.message
      : { responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, kind: "message" as const, text: value, createdAt: new Date().toISOString() };
    pendingMessage.current = { text: value, message: draft };
    try {
      const result = await source.sendMessage(entry, draft);
      pendingMessage.current = null;
      onSaved(entry, result);
      return true;
    } catch { setError("Your message wasn't sent. Try again."); return false; }
    finally { setMessaging(false); }
  }
  async function snooze(until: string) {
    setError(null);
    try { await onSnooze(entry, until); setLater(false); }
    catch { setError("That wasn't saved. Try again."); }
  }
  const details = <MoreSheet open={more} onOpenChange={setMore} title={card.title || "This card"}>
    <SheetSection title="Details">{reference}</SheetSection>
    <CardHistory entry={target} now={now} />
  </MoreSheet>;
  const items = plainThreadItems(entry, revisions);
  const audience = commentCopy({ approved: [entry.source.label], captions });
  const canMessage = !!source.sendMessage;
  const thread = <ThreadView items={items} now={now} open={expanded} composing={composing} input={audience.input} helper={audience.helper} busy={messaging} closed={false} onSend={message} onClose={() => setComposing(false)} />;
  const askButton = canMessage && !composing && <button type="button" className={quietClass} onClick={() => setComposing(true)}>{audience.button}</button>;
  if (!card.needsResponse) return <>
    {thread}
    {error && <ErrorLine>{error}</ErrorLine>}
    {(expanded || items.length > 0) && <QuietRow>{askButton}{expanded && <button type="button" className={quietClass} onClick={() => setMore(true)}>More</button>}</QuietRow>}
    {details}
  </>;
  const asking = !saved || followup || !!text.trim();
  const choose = (choice: string) => {
    if (stale || saving) return;
    countdown.start(optionText(choices.find((option) => option.id === choice)?.label ?? ""), () => void save(choice));
  };
  const reply = () => {
    if (stale || saving || !text.trim()) return;
    countdown.start(NOT_SENT_COPY.yourAnswer, () => void save());
  };
  return <div>
    {countdown.pending ? <PendingAnswer label={countdown.pending.label} seconds={countdown.pending.seconds} onUndo={countdown.undo}>
      {countdown.pending.label === NOT_SENT_COPY.yourAnswer ? <p>Sending your answer…</p> : <p>Sending <b className="font-semibold">{countdown.pending.label}</b>…</p>}
    </PendingAnswer> : <>
      {saved && !asking && <ResponseStatus entry={target} now={now} focusOnMount={justSaved} />}
      {asking && followup && <p className="mt-3.5 text-[13px] text-muted-foreground">A new answer replaces your earlier one. It can't undo what {entry.source.label} already did.</p>}
      {asking && !!choices.length && <OptionButtons options={choices} saving={saving ?? undefined} disabled={!!saving || stale} onChoose={choose} />}
      {asking && (noteOpen || !choices.length) && <form className="mt-3.5" onSubmit={(event) => { event.preventDefault(); reply(); }}>
        <label className="block"><span className="sr-only">Your answer</span><textarea aria-label="Your answer" value={text} disabled={!!saving} onInput={(event) => { setText(event.currentTarget.value); }} className={`${fieldClass} min-h-24 resize-y`} /></label>
        <button type="submit" disabled={!!saving || stale || !text.trim()} className={`mt-2 ${pillClass}`}>{saving === "text" ? "Sending…" : "Send answer"}</button>
      </form>}
    </>}
    {thread}
    {failed ? <AnswerFailedLine held={!!source.holdsAnswer?.(failed.target, failed.responseId)} /> : error && <ErrorLine>{error}</ErrorLine>}
    {!countdown.pending && <QuietRow>
      {asking && !!choices.length && !noteOpen && <button type="button" className={quietClass} onClick={() => setNoteOpen(true)}>Answer in your own words</button>}
      {saved && !asking && <button type="button" className={quietClass} onClick={() => setFollowup(true)}>Change answer</button>}
      {followup && <button type="button" className={quietClass} disabled={!!saving} onClick={() => { setFollowup(false); setText(""); setNoteOpen(false); }}>Keep my answer</button>}
      {attention && <button type="button" className={quietClass} aria-expanded={later} onClick={() => setLater(!later)}>Ask me later</button>}
      {askButton}
      <button type="button" className={quietClass} onClick={() => setMore(true)}>More</button>
    </QuietRow>}
    {later && <SnoozeChoices now={now} onPick={(until) => void snooze(until)} />}
    {details}
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
  const [snapshot, setSnapshot] = useState<HomeFeedSnapshot | null>(null);
  // No segment is pressed until the saved view arrives, so the row never flips while loading.
  const [view, setView] = useState<HomeView | null>(null);
  const [active, setActive] = useState<HomeFeedEntry | null>(null);
  const [sticky, setSticky] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [awake, setAwake] = useState<ReadonlySet<string>>(() => new Set());
  // Answers not sent because the card was replaced during their countdown, by card key.
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Answers held when the page closed and settled at this launch, by card.
  const [heldOutcomes, setHeldOutcomes] = useState<ReadonlyMap<string, HeldAnswerOutcome>>(() => new Map());
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState("");
  const [project, setProject] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [error, setError] = useState<{ lead: string; text: string } | null>(null);
  const [viewBusy, setViewBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  // The Agents list ("list") or one agent's page (its key), shown in place of the cards.
  const [agentView, setAgentView] = useState<string | null>(null);
  // A card opened from an agent's page: it shows in the feed whatever the view.
  const [fromAgent, setFromAgent] = useState<HomeFeedEntry | null>(null);
  const flags = useFeedFlags();
  const openCard = flags.layout === "open-card";
  const openSection = useRef<HTMLElement>(null);
  // Set when the owner opens a card from a row or an agent's page: "open" (the open card) or a card's key.
  const scrollTo = useRef<string | null>(null);
  useEffect(() => {
    const target = scrollTo.current;
    if (!target) return;
    scrollTo.current = null;
    const node = target === "open" ? openSection.current : [...document.querySelectorAll<HTMLElement>("[data-card-key]")].find((element) => element.dataset.cardKey === target);
    node?.scrollIntoView?.({ block: "start" });
  });
  const chosenView = useRef(false);
  const hasDefault = useRef(false);
  const refreshRef = useRef<() => void>(() => {});
  const committed = useRef(new Map<string, FeedResponse>());
  const activeRef = useRef<HomeFeedEntry | null>(null);
  const currentSource = useRef(source);
  const pendingSends = useRef(new Set<() => void>());
  currentSource.current = source;
  const history = view === "done";
  const selector: FeedSelector = view === "all" ? "both" : "needs-action";

  useEffect(() => {
    let alive = true;
    let running = false;
    let dirty = false;
    let loaded = false;
    let flushed = false;
    chosenView.current = false; hasDefault.current = false;
    committed.current.clear();
    activeRef.current = null;
    setSnapshot(null); setView(null); setActive(null); setError(null); setSticky(new Map()); setExpanded(new Set()); setAwake(new Set()); setHeldOutcomes(new Map());
    setExpandedGroups(new Set()); setAgentView(null); setFromAgent(null);
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
          setSnapshot(next); setClock(Date.now()); setError(next.connectionError ? { lead: "You're offline.", text: "Live updates are off, so these cards may be out of date." } : null);
          if (!hasDefault.current && !chosenView.current) setView(next.settings.defaultSelector === "needs-action" ? "needs-you" : "all");
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
      if (!hasDefault.current && !chosenView.current) setView(local.settings.defaultSelector === "needs-action" ? "needs-you" : "all");
    }).catch(() => {}).finally(() => {
      if (alive) unsubscribe = source.subscribe(refreshRef.current);
    });
    void refresh();
    return () => { alive = false; unsubscribe?.(); refreshRef.current = () => {}; };
  }, [source]);

  /**
   * The card's revisions, oldest first: those Home loaded as entries (with their owner history),
   * and the rest of the output's stored revisions, which carry no response, message or view.
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
   * A plain card's run of reply-only revisions ending at `entry`, oldest first: the revisions
   * that differ from their predecessor only by appended agent replies. Typed cards and any
   * other change start a new run.
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
  const entries = history
    ? (() => {
      const all = [...new Map([...(snapshot?.entries ?? []), ...(snapshot?.historicalEntries ?? [])].map((entry) => [keyOf(entry), entry])).values()];
      // A revision that only gained agent replies is shown as its latest revision, once.
      return all.filter((entry) => !all.some((other) => other !== entry && other.state.card.revision > entry.state.card.revision && lineageKey(other) === lineageKey(entry)));
    })()
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
  const matchesFilters = (entry: HomeFeedEntry) => (!agent || entry.source.sourceId === agent) && (!kind || kindOf(entry) === kind) && (!project || projectOf(entry) === project);
  const attention = (entry: HomeFeedEntry) => needsAttention(entry, clock, contextFor(entry)?.projection) && !answeredIn(entry);
  const folded = (entry: HomeFeedEntry) => {
    const typed = contextFor(entry);
    if (!typed?.projection.foldedInto) return false;
    const parent = typed.entries.find((candidate) => { const context = contextFor(candidate); return context?.record.kind === "ask" && context.record.id === typed.projection.foldedInto?.id; });
    return !!parent && matchesFilters(parent) && attention(parent);
  };
  const inDone = (entry: HomeFeedEntry) => entry.state.card.payload?.sitrepThread !== undefined || !!entry.responses?.length || !!entry.state.response || !!answeredIn(entry) || !!entry.viewEvents?.some((event) => event.kind === "snoozed") || !!entry.owner?.answers.length || !!entry.owner?.claimDecisions.length || !!entry.owner?.threads.length || !!entry.owner?.outboundNotes?.length || !!entry.owner?.heldNotes?.length || !!entry.historicalCommands?.length || !!entry.owner?.states.some((state) => state.notes?.length || state.snoozes?.length || state.doneAt || state.dismissedAt || Object.keys(state.steps).length) || snoozedNow(entry, clock);
  // A card the owner touched in this view keeps its place until the view changes,
  // so an answer stays on screen (with "Change answer") instead of vanishing under the tap.
  const keepsNeeds = (entry: HomeFeedEntry) => sticky.get(lineageKey(entry)) === true;
  const needing = (entry: HomeFeedEntry) => (attention(entry) && !(selector === "needs-action" && folded(entry))) || keepsNeeds(entry);
  const needsCount = (snapshot?.entries ?? []).filter((entry) => matchesFilters(entry) && attention(entry) && !folded(entry)).length;
  const matching = entries.filter((entry) => matchesFilters(entry) && (history ? inDone(entry) : selector === "both" || needing(entry)))
    .sort((a, b) => { const first = contextFor(a)?.waiting; const second = contextFor(b)?.waiting; return first && second ? compareWaiting(first, second) || compare(a, b) : compare(a, b); });
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
  const holds = (row: Row, target: HomeFeedEntry) => (row.kind === "card" ? [row.item] : row.items).some((entry) => keyOf(entry) === keyOf(target));
  // A card opened from an agent's page shows first, even where this view or filter leaves it out,
  // as its latest copy here (the open card's, which takes a saved answer at once).
  const pinned = fromAgent && (active && keyOf(active) === keyOf(fromAgent) ? active
    : [...(snapshot?.entries ?? []), ...(snapshot?.historicalEntries ?? [])].find((entry) => keyOf(entry) === keyOf(fromAgent)) ?? fromAgent);
  if (pinned && !rows.some((row) => holds(row, pinned))) rows.unshift({ kind: "card", item: pinned });
  const activeKey = active ? keyOf(active) : null;
  let selected = entries.find((entry) => keyOf(entry) === activeKey)
    ?? (snapshot?.focusedEntry && keyOf(snapshot.focusedEntry) === activeKey ? snapshot.focusedEntry : active);
  // A card the owner is working on stays bound to its exact issuance when a newer one
  // arrives: it keeps its place (in place of its successor) until the owner moves on.
  // A successor that only appends agent replies swaps in place instead.
  if (selected && !rows.some((row) => (row.kind === "card" ? [row.item] : row.items).some((entry) => keyOf(entry) === keyOf(selected!)))) {
    const current = selected;
    const successor = rows.findIndex((row) => row.kind === "card" && row.item.source.sourceId === current.source.sourceId && row.item.state.card.cardId === current.state.card.cardId);
    const next = successor >= 0 ? rows[successor] : undefined;
    if (next?.kind === "card" && !isTypedPayload(current) && isReplyOnlyRevision(current, next.item)) selected = next.item;
    else if (successor >= 0) rows[successor] = { kind: "card", item: current, retained: true };
    else if (!entries.some((entry) => keyOf(entry) === keyOf(current))) rows.unshift({ kind: "card", item: current, retained: true });
  }
  const selectedKey = selected ? keyOf(selected) : null;
  activeRef.current = selected ?? null;
  useEffect(() => { if (selected && activeKey && selectedKey !== activeKey) setActive(selected); }, [selectedKey, activeKey]);
  const filteredCount = rows.reduce((count, row) => count + (row.kind === "card" ? 1 : row.items.length), 0);

  useEffect(() => {
    if (!selected || selected.view.seenAt) return;
    let alive = true;
    void source.markSeen(selected).then(() => {
      if (!alive) return;
      const seenAt = new Date().toISOString();
      const update = (entry: HomeFeedEntry): HomeFeedEntry => ({ ...entry, view: { ...entry.view, seenAt } });
      setSnapshot((current) => updateSnapshotEntry(current, selectedKey!, update));
      setActive((current) => current && keyOf(current) === selectedKey ? update(current) : current);
    }).catch(() => { /* Seen is a hint; the card stays as it is. */ });
    return () => { alive = false; };
  }, [source, selectedKey]);

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
  function changeView(next: HomeView) {
    if (next === view) return;
    // Answers still counting down are sent now: the owner chose them, then moved on.
    for (const send of [...pendingSends.current]) send();
    chosenView.current = true; setView(next); setActive(null); setSticky(new Map()); setExpanded(new Set()); setFromAgent(null); setAgentView(null);
    if (next === "done") return;
    // The last view is the next session's default; a failed write only loses that preference.
    const value: FeedSelector = next === "needs-you" ? "needs-action" : "both";
    if (snapshot?.settings.defaultSelector === value) return;
    setSnapshot((current) => current ? { ...current, settings: { defaultSelector: value } } : current);
    source.setDefaultSelector(value).catch(() => {});
  }
  function engage(entry: HomeFeedEntry) {
    if (keyOf(entry) !== activeKey) setActive(entry);
    const key = lineageKey(entry);
    if (!sticky.has(key)) setSticky((current) => new Map(current).set(key, view !== "done" && attention(entry)));
  }
  function toggle(entry: HomeFeedEntry) {
    engage(entry);
    const key = lineageKey(entry);
    setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }
  function release(entry: HomeFeedEntry) {
    const key = lineageKey(entry);
    setRefused((current) => { const next = new Map(current); next.delete(key); return next; });
    setHeldOutcomes((current) => { const next = new Map(current); next.delete(JSON.stringify([entry.source.sourceId, entry.state.card.cardId])); return next; });
    setSticky((current) => { const next = new Map(current); next.delete(key); return next; });
    if (keyOf(entry) === activeKey) setActive(null);
  }
  const snooze = useCallback(async (entry: HomeFeedEntry, until: string) => {
    await source.snooze(entry, until);
    const key = keyOf(entry);
    setSnapshot((current) => updateSnapshotEntry(current, key, (candidate) => ({ ...candidate, view: { ...candidate.view, snoozedUntil: until } })));
    release(entry);
    const lineage = lineageKey(entry);
    setAwake((current) => { const next = new Set(current); next.delete(lineage); return next; });
  }, [source, activeKey]);
  function setFilter(update: () => void) { update(); setActive(null); setSticky(new Map()); setFromAgent(null); }

  async function saveGroup(entry: HomeFeedEntry, group: string, on: boolean) {
    setViewBusy(true); setError(null);
    try {
      if (!source.setGroupPriority) throw new Error("This feed source does not provide private group storage");
      await source.setGroupPriority(entry, group, on); refreshRef.current();
    } catch { setError({ lead: "That wasn't saved.", text: "Try again." }); }
    finally { setViewBusy(false); }
  }

  function chipFor(entry: HomeFeedEntry): ReactNode {
    const context = contextFor(entry);
    if (snoozedNow(entry, clock)) return <span className={chipClass}>Snoozed until {dueTime(entry.view.snoozedUntil!, clock)}</span>;
    if (context) {
      if (context.projection.attention === "closed" || isClosed(context.record)) return <span className={chipClass}>Closed</span>;
      if (context.projection.answer) return <span className={chipClass}>Answered</span>;
      return null;
    }
    return answeredIn(entry) ? <span className={chipClass}>Answered</span> : null;
  }
  /** `top`: the open card of the open-card layout, always open and raised above the rows. */
  function renderCard(entry: HomeFeedEntry, retained = false, top = false) {
    const key = lineageKey(entry);
    const held = heldOutcomes.get(JSON.stringify([entry.source.sourceId, entry.state.card.cardId]));
    const heldLabel = held?.choiceLabel ? optionText(held.choiceLabel) : NOT_SENT_COPY.yourAnswer;
    const refusedLabel = refused.get(key) ?? (retained && held?.answered && keyOf(held.answered) === keyOf(entry) ? heldLabel : undefined);
    const onRefused = (label: string) => setRefused((current) => new Map(current).set(key, label));
    const context = contextFor(entry);
    const unsupported = isTypedPayload(entry) && !context;
    const open = top || expanded.has(key);
    // A snoozed card rests as its title until the owner asks to answer it now.
    const resting = snoozedNow(entry, clock) && !awake.has(key) && !open;
    const reference = <Reference title={homeFeedKey(entry)}>{humanFeedReference(entry, entries)}</Reference>;
    const comments = context ? threadSize(entry, context.record, context.owner) : unsupported ? 0 : plainThreadItems(entry, revisionsOf(entry).filter((candidate) => keyOf(candidate) !== keyOf(entry))).length;
    const author = cardAuthor(entry, context?.record);
    const agentId = agentKey(entry, context?.record);
    return <li key={key} data-card-key={key} className="min-w-0">
      <FeedCardView card={cardView(entry, context)} sample={false} readBody={source.readBody} now={clock} heading="h3" chip={chipFor(entry)} comments={resting ? 0 : comments} onOpenComments={() => { if (!open) toggle(entry); }} expanded={open} compact={resting || unsupported} clampTitle={!top && (view === "done" || !needing(entry))} onToggle={top ? undefined : () => toggle(entry)} onEngage={() => engage(entry)}
        agent={{ key: agentId, ...(author.via ? { via: author.via } : {}), profile: agentProfile(entry.state.card.payload) }} onOpenAgent={unsupported ? undefined : () => setAgentView(agentId)} raised={top}>
        {resting && <QuietRow><button type="button" className={quietClass} onClick={() => { engage(entry); setAwake((current) => new Set(current).add(key)); }}>Answer now</button></QuietRow>}
        {!resting && <>
        {retained && <div role={refusedLabel ? "alert" : "status"} className="mt-3 flex flex-wrap items-center gap-x-3 text-[13px] text-muted-foreground"><span>{refusedLabel
          ? <NotSent label={refusedLabel} changed />
          : "A newer version of this card arrived. Answer it there; your draft stays here."}</span><button type="button" className={quietClass} onClick={() => release(entry)}>Show the newer version</button></div>}
        {!retained && held?.outcome === "sent" && <p role="status" className="mt-3 text-[13px] text-muted-foreground">{HELD_ANSWER_COPY.sent}</p>}
        {!retained && (held?.outcome === "closed" || held?.outcome === "refused") && <p role="alert" className="mt-3 text-[13px]"><NotSent label={heldLabel} /></p>}
        <ReportLink entry={entry} />
        {context
          ? <SitrepCard key={key} entry={entry} record={context.record} records={context.records} entries={context.entries} owner={context.owner} projection={context.projection} source={source} now={clock} expanded={open} stale={retained} reference={reference} onRefused={onRefused} onSaved={onSaved} onOwnerSaved={() => refreshRef.current()} onSnoozed={release} onNavigate={(next) => { setActive(next); setExpanded((current) => new Set(current).add(keyOf(next))); }} />
          : unsupported
            ? <p role="status" className="mt-3.5 text-sm">Ask your agent about this card.</p>
            : <AnswerForm key={key} entry={entry} answered={answeredIn(entry)} onRefused={onRefused} revisions={revisionsOf(entry).filter((candidate) => keyOf(candidate) !== keyOf(entry))} source={source} now={clock} attention={attention(entry)} expanded={open} stale={retained} reference={reference} onSaved={onSaved} onSnooze={snooze} />}
        </>}
      </FeedCardView>
    </li>;
  }
  /** A card as one line under the open card: its agent's mark, its title, and who sent it on which platform. */
  function renderLine(entry: HomeFeedEntry, openedKey: string | null) {
    const context = contextFor(entry);
    const author = cardAuthor(entry, context?.record).name;
    const platform = agentProfile(entry.state.card.payload)?.platform;
    return <li key={keyOf(entry)} className="min-w-0">
      <button type="button" aria-current={keyOf(entry) === openedKey ? "true" : undefined} onClick={() => { engage(entry); scrollTo.current = "open"; }}
        className={`flex min-h-14 w-full min-w-0 items-center gap-3 rounded-md px-1 py-2 text-left hover:bg-muted aria-[current=true]:bg-muted ${focusRing}`}>
        <AgentMark agentKey={agentKey(entry, context?.record)} name={author} />
        <span className="min-w-0 flex-1"><span className="block break-words text-[15px] font-semibold">{entry.state.card.title}</span><span className="block break-words text-[13px] text-muted-foreground">{author}{platform && ` · ${platform}`}</span></span>
        {chipFor(entry)}
      </button>
    </li>;
  }
  function renderRow(row: Row, openedKey: string | null) {
    if (row.kind === "card") return openCard ? renderLine(row.item, openedKey) : renderCard(row.item, row.retained);
    const first = row.items[0]; const record = first && contextFor(first)?.record; const name = record && cardGroup(record);
    if (!first || !name) throw new Error("Invalid grouped Home card");
    const open = expandedGroups.has(row.name);
    const pinned = groupPriorityFlag(contextFor(first)?.owner.groupPriority?.groups[name], row.items.map((entry) => { const context = contextFor(entry); return !!context && !!cardPriority(context.record, context.projection.state?.priority); }));
    return <li key={row.name}>
      <section aria-label={`Card group ${name}`} className={openCard ? "py-1" : "rounded-[20px] bg-muted/50 p-2"}>
        <div className={`flex flex-wrap items-center gap-x-3 ${openCard ? "px-1" : "px-2"}`}>
          <button type="button" className={`inline-flex min-h-11 grow items-center gap-1.5 text-left text-[15px] font-semibold ${focusRing}`} aria-expanded={open} onClick={() => setExpandedGroups((previous) => { const next = new Set(previous); if (next.has(row.name)) next.delete(row.name); else next.add(row.name); return next; })}>{openCard && <ChevronRightIcon aria-hidden className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />}{name} <span className="font-normal tabular-nums text-muted-foreground">{row.items.length} cards</span></button>
          <button type="button" disabled={viewBusy} aria-pressed={pinned} className={quietClass} onClick={() => void saveGroup(first, name, !pinned)}>{pinned ? "Clear priority" : "Mark priority"}</button>
        </div>
        {open && (openCard
          ? <ul className="divide-y divide-border pl-6">{row.items.map((entry) => renderLine(entry, openedKey))}</ul>
          : <ul className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-3">{row.items.map((entry) => renderCard(entry))}</ul>)}
      </section>
    </li>;
  }
  const rowNeeds = (row: Row) => (row.kind === "card" ? [row.item] : row.items).some(needing);
  const cardCount = (list: readonly Row[]) => list.reduce((count, row) => count + (row.kind === "card" ? 1 : row.items.length), 0);
  /**
   * One section of cards. With the agents menu every heading shows, as "Needs you · 3"; otherwise as
   * approved ("Needs you 3", and hidden when it is the view's only section).
   */
  function group(label: string, list: Row[], openedKey: string | null, count?: number, hidden = false) {
    if (!list.length) return null;
    const headingId = `home-group-${label.toLowerCase().replace(/\s+/g, "-")}`;
    return <section aria-labelledby={headingId} className="mt-6">
      {flags.nav === "agents"
        ? <h2 id={headingId} className="mb-2.5 text-[13px] font-semibold leading-none">{label} <span className="font-normal tabular-nums text-muted-foreground">· {count ?? cardCount(list)}</span></h2>
        : <h2 id={headingId} className={hidden ? "sr-only" : "mb-2.5 flex gap-1.5 text-[13px] font-semibold leading-none"}>{label}{count !== undefined && <span className="font-normal tabular-nums text-muted-foreground">{count}</span>}</h2>}
      <ul className={openCard ? "divide-y divide-border border-y border-border" : "grid grid-cols-[minmax(0,1fr)] gap-3"}>{list.map((row) => renderRow(row, openedKey))}</ul>
    </section>;
  }
  /** The view's sections: the open card (open-card layout), then the cards by whether they need the owner. */
  function cardSections() {
    const cards = rows.flatMap((row) => row.kind === "card" ? [{ item: row.item, retained: !!row.retained }] : row.items.map((item) => ({ item, retained: false })));
    const opened = openCard ? (selected && cards.find((card) => keyOf(card.item) === keyOf(selected!))) || cards.find((card) => needing(card.item)) || cards[0] : undefined;
    const openedKey = opened ? keyOf(opened.item) : null;
    const listed = opened ? rows.filter((row) => row.kind === "group" || keyOf(row.item) !== openedKey) : rows;
    const needs = rows.filter(rowNeeds), rest = rows.filter((row) => !rowNeeds(row));
    const agentsMenu = flags.nav === "agents";
    return <>
      {opened && <section ref={openSection} aria-label="Open card" className="mt-6 scroll-mt-4"><ul className="grid grid-cols-[minmax(0,1fr)]">{renderCard(opened.item, opened.retained, true)}</ul></section>}
      {view === "all"
        ? <>{group("Needs you", listed.filter(rowNeeds), openedKey, agentsMenu ? cardCount(needs) : needsCount)}{group(agentsMenu ? "Updates" : "Earlier", listed.filter((row) => !rowNeeds(row)), openedKey, agentsMenu ? cardCount(rest) : undefined)}</>
        : group(view === "done" ? "History" : "Needs you", listed, openedKey, agentsMenu ? cardCount(rows) : undefined, true)}
    </>;
  }

  const agents = [...new Map((snapshot?.entries ?? []).map((entry) => [entry.source.sourceId, entry.source.label])).entries()];
  const projects = [...new Set((snapshot?.entries ?? []).map(projectOf).filter(Boolean))].sort();
  const kinds = [...new Set((snapshot?.entries ?? []).map(kindOf))].sort();
  const activeFilters = [agent, kind, project].filter(Boolean).length;
  const filtering = activeFilters > 0;
  const today = (snapshot?.entries ?? []).filter((entry) => !attention(entry) && new Date(entry.state.card.createdAt).toDateString() === new Date(clock).toDateString()).length;
  // The Home site shows only the heading and its empty state until the first card arrives.
  // The Home site shows only the heading and its empty card until the first card arrives;
  // while loading, the control row is already in place so nothing moves when cards land.
  const bare = !!snapshot && !snapshot.entries.length && !snapshot.historicalEntries?.length;
  const selectClass = `mt-2 block h-11 w-full rounded-xl bg-background px-3 text-[15px] shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))] ${focusRing}`;
  const switched = changedFlags(flags);
  // The Agents list and an agent's page: one card per card (its latest revision), from everything Home loaded.
  const latest = new Map<string, HomeFeedEntry>();
  for (const entry of agentView ? [...(snapshot?.entries ?? []), ...(snapshot?.historicalEntries ?? [])] : []) {
    const id = JSON.stringify([entry.source.sourceId, entry.state.card.cardId]);
    if ((latest.get(id)?.state.card.revision ?? -1) < entry.state.card.revision) latest.set(id, entry);
  }
  const agentList = agentView ? agentThreads([...latest.values()], contextFor, (entry) => {
    const context = contextFor(entry);
    return context ? typedCommentItems(entry, context.record, context.owner) : isTypedPayload(entry) ? [] : plainThreadItems(entry, revisionsOf(entry).filter((candidate) => keyOf(candidate) !== keyOf(entry)));
  }, attention) : [];
  const shownAgent = agentView && agentView !== "list" ? agentList.find((thread) => thread.key === agentView) : undefined;
  function openFromAgent(entry: HomeFeedEntry) {
    setAgentView(null); setFromAgent(entry); engage(entry);
    const key = lineageKey(entry);
    setExpanded((current) => new Set(current).add(key));
    scrollTo.current = openCard ? "open" : key;
  }
  return <PendingSendContext.Provider value={pendingSends.current}><main className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-background text-foreground" aria-label={NAV_LABEL_HOME}>
    <div className="mx-auto w-full max-w-[672px] min-w-0 px-4 pb-[calc(var(--tc-bottom-chrome)+2rem)] pt-5 sm:px-6 lg:px-8 lg:pt-10">
      <header>
        <h1 className="font-display text-[min(1.75rem,9vw)] font-semibold leading-[2.125rem] tracking-[-0.005em]">{NAV_LABEL_HOME}</h1>
        <p className="mt-1 text-sm leading-[1.45] text-muted-foreground">{snapshot && !bare
          ? <>{needsCount ? <b className="font-semibold text-foreground">{needsCount} {needsCount === 1 ? "needs" : "need"} you.</b> : <b className="font-semibold text-foreground">Nothing needs you.</b>}{today > 0 && ` ${today} ${today === 1 ? "update" : "updates"} today.`}</>
          : "Updates and decisions from your agents."}</p>
        {switched.length > 0 && <p data-feed-flags className="mt-1 text-[12.5px] text-muted-foreground">Feed switches: {switched.join(" · ")}</p>}
      </header>
      {ask}
      {!bare && (flags.nav === "agents"
        ? <div className="mt-4 flex flex-wrap items-center gap-2">
          <select aria-label="Feed view" value={view ?? ""} onChange={(event) => changeView(event.target.value as HomeView)}
            className={`h-11 min-w-0 rounded-full bg-background pl-4 pr-3 text-base font-semibold shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))] ${focusRing}`}>
            {view === null && <option value="" disabled hidden />}
            {VIEWS.map((option) => <option key={option.id} value={option.id}>{option.label}{option.id === "needs-you" && snapshot ? ` ${needsCount}` : ""}</option>)}
          </select>
          <button type="button" aria-pressed={!!agentView} onClick={() => setAgentView(agentView ? null : "list")}
            className={`ml-auto h-11 rounded-full px-4 text-sm font-medium shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))] aria-pressed:bg-muted aria-pressed:font-semibold ${focusRing}`}>Agents</button>
          {(agents.length > 1 || projects.length > 1 || filtering) && <button type="button" aria-haspopup="dialog" onClick={() => setFilterOpen(true)}
            className={`h-11 rounded-full px-4 text-sm font-medium shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))] ${filtering ? "bg-muted font-semibold" : ""} ${focusRing}`}>{activeFilters ? `Filter · ${activeFilters}` : "Filter"}</button>}
        </div>
        : <div className="mt-4 flex items-center gap-2">
          <div role="group" aria-label="Show" className="flex gap-0.5 rounded-full bg-muted">
            {VIEWS.map((option) => <button key={option.id} data-testid={`feed-view-${option.id}`} type="button" aria-pressed={view === option.id} onClick={() => changeView(option.id)}
              className={`h-11 whitespace-nowrap rounded-full px-4 text-sm font-medium aria-pressed:bg-background aria-pressed:font-semibold aria-pressed:shadow-[inset_0_0_0_2px_hsl(var(--foreground))] ${focusRing}`}>
              {option.label}{option.id === "needs-you" && snapshot && <span className="ml-1 tabular-nums">{needsCount}</span>}
            </button>)}
          </div>
          {(agents.length > 1 || projects.length > 1 || filtering) && <button type="button" aria-haspopup="dialog" aria-label={`Filter by agent or project${activeFilters ? `, ${activeFilters} active` : ""}`} onClick={() => setFilterOpen(true)}
            className={`relative ml-auto grid size-11 shrink-0 place-items-center rounded-full shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))] ${focusRing}`}>
            <SlidersHorizontalIcon aria-hidden className="size-5" />
            {!!activeFilters && <span aria-hidden className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-foreground px-1 text-[11px] font-semibold tabular-nums text-background">{activeFilters}</span>}
          </button>}
        </div>)}
      <ResponsiveSheet open={filterOpen} onOpenChange={setFilterOpen} title={<span className="block text-[1.375rem] font-normal leading-[1.2]">Filter</span>}>
        <ResponsiveSheetBody className="space-y-4 pb-6">
          <label className="block text-[13px] font-semibold">Agent<select aria-label="Filter by agent" className={selectClass} value={agent} onChange={(event) => { const value = event.target.value; setFilter(() => setAgent(value)); }}><option value="">All agents</option>{agents.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          {projects.length > 0 && <label className="block text-[13px] font-semibold">Project<select aria-label="Filter by project" className={selectClass} value={project} onChange={(event) => { const value = event.target.value; setFilter(() => setProject(value)); }}><option value="">All projects</option>{projects.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
          <label className="block text-[13px] font-semibold">Type<select aria-label="Filter by type" className={selectClass} value={kind} onChange={(event) => { const value = event.target.value; setFilter(() => setKind(value)); }}><option value="">All types</option>{kinds.map((value) => <option key={value} value={value}>{kindWord(value)}</option>)}</select></label>
          {filtering && <button type="button" className={pillClass} onClick={() => setFilter(() => { setAgent(""); setKind(""); setProject(""); })}>Clear filter</button>}
        </ResponsiveSheetBody>
      </ResponsiveSheet>
      {error && <div role="alert" className="mt-4 flex items-start gap-3 rounded-2xl bg-card px-4 py-3 text-sm leading-[1.45] shadow-[inset_0_0_0_1px_hsl(var(--border))]">
        <TriangleAlertIcon aria-hidden className="mt-px size-5 shrink-0 text-warning" />
        <div className="min-w-0"><p><b className="font-semibold">{error.lead}</b> {error.text}</p><button type="button" onClick={() => refreshRef.current()} className={`mt-2 ${pillClass}`}>Try again</button></div>
      </div>}
      {!snapshot && !error && <ul aria-busy="true" aria-label="Loading your feed" className="mt-6 grid gap-3">
        {[0, 1, 2].map((index) => <li key={index} aria-hidden className={`${cardClass} space-y-3`}>
          <div className="flex items-center gap-2"><span className="size-7 rounded-full bg-muted" /><span className="h-3 w-2/5 rounded-full bg-muted" /></div>
          <div className="h-3.5 w-4/5 rounded-full bg-muted" />
          <div className="h-3.5 w-3/5 rounded-full bg-muted" />
          <div className="h-14" />
        </li>)}
      </ul>}
      {agentView && snapshot && (shownAgent
        ? <AgentConversation key={shownAgent.key} agent={shownAgent} now={clock} onBack={() => setAgentView("list")} onOpenCard={openFromAgent} />
        : <AgentList agents={agentList} now={clock} onOpen={setAgentView} onBack={() => setAgentView(null)} />)}
      {!agentView && snapshot && !filteredCount && (bare
        ? <section aria-labelledby="home-empty-title" className={`mt-6 ${cardClass}`}>
          <h2 id="home-empty-title" className="font-display text-[1.375rem] font-normal leading-[1.2]">{HOME_EMPTY_TITLE}</h2>
          <p className="mt-2 max-w-[60ch] text-base leading-[1.5]">{HOME_EMPTY_BODY}</p>
          <Link to={PATHS.chat} className={primaryPillClass}>{HOME_EMPTY_CHAT}</Link>
          <AgentPrompt copyButton={({ onClick, children }) => <button type="button" className={primaryPillClass} onClick={onClick}>{children}</button>}
            aside={<a href={FEED_SKILL_URL} target="_blank" rel="noopener noreferrer" className={quietClass}>{HOME_EMPTY_HOW}</a>} />
        </section>
        : <div className="mt-6 rounded-[20px] px-[18px] py-4 text-[15px] text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]">
          <p>{filtering ? "No cards match this filter." : history ? "Nothing answered or snoozed yet." : view === "needs-you" ? "Nothing needs you." : "No cards yet."}</p>
          {filtering && <button type="button" className={`mt-2 ${pillClass} text-foreground`} onClick={() => setFilter(() => { setAgent(""); setKind(""); setProject(""); })}>Clear filter</button>}
        </div>)}
      {!agentView && !!filteredCount && cardSections()}
    </div>
  </main></PendingSendContext.Provider>;
}
