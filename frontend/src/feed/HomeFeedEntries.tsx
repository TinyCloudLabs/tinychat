import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontalIcon, TriangleAlertIcon } from "lucide-react";
import type { FeedResponse, FeedSelector, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { FeedCardView } from "./FeedView";
import { safeUrl, type FeedCard } from "./feedData";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { SitrepCard } from "./SitrepCard";
import { typedContexts } from "./sitrepProjection";
import { humanFeedReference, homeFeedKey, homeGroupScope } from "./feedIdentity";
import { AnsweredPanel, cardClass, cardTime, chipClass, dueTime, ErrorLine, fieldClass, focusRing, kindWord, MoreSheet, OptionButtons, optionText, PendingAnswer, PendingSendContext, pillClass, primaryPillClass, QuietRow, quietClass, Reference, SheetSection, SnoozeChoices, usePendingSend } from "./cardKit";
import { cardGroup, cardPriority, compareWaiting, DUE_WINDOW_MS, groupCards, groupPriorityFlag, isClosed, orderPriority, type SitrepProjection } from "@tinyboilerplate/core/feed/sitrep";
import { HOME_SITE } from "@/lib/homeSite";
import { HOME_EMPTY_BODY, HOME_EMPTY_HOW, HOME_EMPTY_TITLE, NAV_LABEL_HOME } from "@/lib/homeStrings";
import { AgentPrompt } from "@/home/AgentPromptCard";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import { FEED_SKILL_URL } from "./strings";

type HomeView = "needs-you" | "all" | "done";
const VIEWS: readonly { id: HomeView; label: string }[] = [{ id: "needs-you", label: "Needs you" }, { id: "all", label: "All" }, { id: "done", label: "Done" }];

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
function cardView(entry: HomeFeedEntry): FeedCard {
  const card = entry.state.card;
  const payload = card.payload ?? {};
  const render = ["post", "image", "thread", "article", "link"].includes(String(payload.render)) ? payload.render as FeedCard["render"] : "post";
  const source = payload.source;
  const sourceRecord = source && typeof source === "object" ? source as Record<string, unknown> : undefined;
  return {
    key: keyOf(entry), at: card.createdAt, author: { name: entry.source.label }, render,
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

/** An untyped card's answer: one tap on an option, or a reply in words, sent after a short undo window. */
function AnswerForm({ entry, source, now, attention, expanded, reference, stale = false, onSaved, onSnooze }: {
  entry: HomeFeedEntry; source: HomeFeedSource; now: number; attention: boolean; expanded: boolean; reference: ReactNode;
  /** A newer issuance replaced this card: its draft stays, but it can no longer be answered. */
  stale?: boolean;
  onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void;
  onSnooze: (entry: HomeFeedEntry, until: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState(false);
  const [later, setLater] = useState(false);
  const [more, setMore] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const countdown = usePendingSend();
  const pendingResponse = useRef<{ key: string; response: NewFeedResponse } | null>(null);
  const card = entry.state.card;
  const choices = card.choices ?? [];
  const saved = entry.state.response;
  async function save(choice?: string) {
    if (stale || saving || (!text.trim() && !choice)) return;
    setSaving(choice ?? "text"); setError(null);
    // Retain the response identity across a failed/ambiguous write. A retry of
    // the same answer cannot create a second one because its first write was lost.
    const key = JSON.stringify([choice ?? null, text.trim()]);
    const response = pendingResponse.current?.key === key ? pendingResponse.current.response : {
      responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
      kind: saved ? "followup" as const : "answer" as const,
      ...(choice ? { choiceId: choice } : {}), ...(text.trim() ? { text: text.trim() } : {}),
      ...(saved ? { supersedesResponseId: saved.responseId } : {}), createdAt: new Date().toISOString(),
    };
    pendingResponse.current = { key, response };
    try {
      const result = await source.saveResponse(entry, response);
      onSaved(entry, result);
      pendingResponse.current = null;
      setText(""); setNoteOpen(false); setFollowup(false); setJustSaved(true);
    } catch {
      setError("Your answer wasn't saved. Try again.");
    } finally { setSaving(null); }
  }
  async function snooze(until: string) {
    setError(null);
    try { await onSnooze(entry, until); setLater(false); }
    catch { setError("That wasn't saved. Try again."); }
  }
  const details = <MoreSheet open={more} onOpenChange={setMore} title={card.title || "This card"}>
    <SheetSection title="Details">{reference}</SheetSection>
    <CardHistory entry={entry} now={now} />
  </MoreSheet>;
  if (!card.needsResponse) return expanded ? <QuietRow><button type="button" className={quietClass} onClick={() => setMore(true)}>More</button>{details}</QuietRow> : null;
  const asking = !saved || followup || !!text.trim();
  const choose = (choice: string) => {
    if (stale || saving) return;
    countdown.start(optionText(choices.find((option) => option.id === choice)?.label ?? ""), () => void save(choice));
  };
  const reply = () => {
    if (stale || saving || !text.trim()) return;
    countdown.start("your reply", () => void save());
  };
  if (countdown.pending) return <PendingAnswer label={countdown.pending.label} seconds={countdown.pending.seconds} onUndo={countdown.undo}>
    {countdown.pending.label === "your reply" ? <p>You replied: <span className="whitespace-pre-wrap">{text.trim()}</span></p> : <p>You chose <b className="font-semibold">{countdown.pending.label}</b>.</p>}
  </PendingAnswer>;
  return <div>
    {saved && !asking && <ResponseStatus entry={entry} focusOnMount={justSaved} />}
    {asking && followup && <p className="mt-3.5 text-[13px] text-muted-foreground">A new answer replaces your earlier one. It can't undo what {entry.source.label} already did.</p>}
    {asking && !!choices.length && <OptionButtons options={choices} saving={saving ?? undefined} disabled={!!saving || stale} onChoose={choose} />}
    {asking && (noteOpen || !choices.length) && <form className="mt-3.5" onSubmit={(event) => { event.preventDefault(); reply(); }}>
      <label className="block text-[13px] font-semibold">Reply in words<textarea aria-label="Your answer" value={text} disabled={!!saving} onInput={(event) => { setText(event.currentTarget.value); }} className={`${fieldClass} min-h-24 resize-y`} /></label>
      <button type="submit" disabled={!!saving || stale || !text.trim()} className={`mt-2 ${pillClass}`}>{saving === "text" ? "Sending…" : "Send"}</button>
    </form>}
    {error && <ErrorLine>{error}</ErrorLine>}
    <QuietRow>
      {asking && !!choices.length && !noteOpen && <button type="button" className={quietClass} onClick={() => setNoteOpen(true)}>Reply in words</button>}
      {saved && !asking && <button type="button" className={quietClass} onClick={() => setFollowup(true)}>Change answer</button>}
      {followup && <button type="button" className={quietClass} disabled={!!saving} onClick={() => { setFollowup(false); setText(""); setNoteOpen(false); }}>Keep my answer</button>}
      {attention && <button type="button" className={quietClass} aria-expanded={later} onClick={() => setLater(!later)}>Ask me later</button>}
      <button type="button" className={quietClass} onClick={() => setMore(true)}>More</button>
    </QuietRow>
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

export function HomeFeedEntries({ source, homeSite = HOME_SITE }: { source: HomeFeedSource; homeSite?: boolean }) {
  const [snapshot, setSnapshot] = useState<HomeFeedSnapshot | null>(null);
  // No segment is pressed until the saved view arrives, so the row never flips while loading.
  const [view, setView] = useState<HomeView | null>(null);
  const [active, setActive] = useState<HomeFeedEntry | null>(null);
  const [sticky, setSticky] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [awake, setAwake] = useState<ReadonlySet<string>>(() => new Set());
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState("");
  const [project, setProject] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [error, setError] = useState<{ lead: string; text: string } | null>(null);
  const [viewBusy, setViewBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
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
    chosenView.current = false; hasDefault.current = false;
    committed.current.clear();
    activeRef.current = null;
    setSnapshot(null); setView(null); setActive(null); setError(null); setSticky(new Map()); setExpanded(new Set()); setAwake(new Set());
    setExpandedGroups(new Set());
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
          setSnapshot(next); setClock(Date.now()); setError(next.connectionError ? { lead: "You're offline.", text: "Live updates are off, so these cards may be out of date." } : null);
          if (!hasDefault.current && !chosenView.current) setView(next.settings.defaultSelector === "needs-action" ? "needs-you" : "all");
          hasDefault.current = true;
        } catch {
          if (alive) setError({ lead: "Home didn't load.", text: "Check your connection, then try again." });
        }
      } while (alive && dirty);
      running = false;
    };
    refreshRef.current = () => { void refresh(); };
    const unsubscribe = source.subscribe(refreshRef.current);
    void refresh();
    return () => { alive = false; unsubscribe(); refreshRef.current = () => {}; };
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
  const matchesFilters = (entry: HomeFeedEntry) => (!agent || entry.source.sourceId === agent) && (!kind || kindOf(entry) === kind) && (!project || projectOf(entry) === project);
  const attention = (entry: HomeFeedEntry) => needsAttention(entry, clock, contextFor(entry)?.projection);
  const folded = (entry: HomeFeedEntry) => {
    const typed = contextFor(entry);
    if (!typed?.projection.foldedInto) return false;
    const parent = typed.entries.find((candidate) => { const context = contextFor(candidate); return context?.record.kind === "ask" && context.record.id === typed.projection.foldedInto?.id; });
    return !!parent && matchesFilters(parent) && attention(parent);
  };
  const inDone = (entry: HomeFeedEntry) => entry.state.card.payload?.sitrepThread !== undefined || !!entry.responses?.length || !!entry.state.response || !!entry.viewEvents?.some((event) => event.kind === "snoozed") || !!entry.owner?.answers.length || !!entry.owner?.claimDecisions.length || !!entry.owner?.threads.length || !!entry.owner?.outboundNotes?.length || !!entry.owner?.heldNotes?.length || !!entry.historicalCommands?.length || !!entry.owner?.states.some((state) => state.notes?.length || state.snoozes?.length || state.doneAt || state.dismissedAt || Object.keys(state.steps).length) || snoozedNow(entry, clock);
  // A card the owner touched in this view keeps its place until the view changes,
  // so an answer stays on screen (with "Change answer") instead of vanishing under the tap.
  const keepsNeeds = (entry: HomeFeedEntry) => sticky.get(keyOf(entry)) === true;
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
  const activeKey = active ? keyOf(active) : null;
  const selected = entries.find((entry) => keyOf(entry) === activeKey)
    ?? (snapshot?.focusedEntry && keyOf(snapshot.focusedEntry) === activeKey ? snapshot.focusedEntry : active);
  const selectedKey = selected ? keyOf(selected) : null;
  activeRef.current = selected ?? null;
  // A card the owner is working on stays bound to its exact issuance when a newer one
  // arrives: it keeps its place (in place of its successor) until the owner moves on.
  if (selected && !rows.some((row) => (row.kind === "card" ? [row.item] : row.items).some((entry) => keyOf(entry) === selectedKey))) {
    const successor = rows.findIndex((row) => row.kind === "card" && row.item.source.sourceId === selected.source.sourceId && row.item.state.card.cardId === selected.state.card.cardId);
    if (successor >= 0) rows[successor] = { kind: "card", item: selected, retained: true };
    else if (!entries.some((entry) => keyOf(entry) === selectedKey)) rows.unshift({ kind: "card", item: selected, retained: true });
  }
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
    chosenView.current = true; setView(next); setActive(null); setSticky(new Map()); setExpanded(new Set());
    if (next === "done") return;
    // The last view is the next session's default; a failed write only loses that preference.
    const value: FeedSelector = next === "needs-you" ? "needs-action" : "both";
    if (snapshot?.settings.defaultSelector === value) return;
    setSnapshot((current) => current ? { ...current, settings: { defaultSelector: value } } : current);
    source.setDefaultSelector(value).catch(() => {});
  }
  function engage(entry: HomeFeedEntry) {
    const key = keyOf(entry);
    if (key !== activeKey) setActive(entry);
    if (!sticky.has(key)) setSticky((current) => new Map(current).set(key, view !== "done" && attention(entry)));
  }
  function toggle(entry: HomeFeedEntry) {
    engage(entry);
    const key = keyOf(entry);
    setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }
  function release(entry: HomeFeedEntry) {
    const key = keyOf(entry);
    setSticky((current) => { const next = new Map(current); next.delete(key); return next; });
    if (key === activeKey) setActive(null);
  }
  const snooze = useCallback(async (entry: HomeFeedEntry, until: string) => {
    await source.snooze(entry, until);
    const key = keyOf(entry);
    setSnapshot((current) => updateSnapshotEntry(current, key, (candidate) => ({ ...candidate, view: { ...candidate.view, snoozedUntil: until } })));
    release(entry);
    setAwake((current) => { const next = new Set(current); next.delete(key); return next; });
  }, [source, activeKey]);
  function setFilter(update: () => void) { update(); setActive(null); setSticky(new Map()); }

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
    return entry.state.response ? <span className={chipClass}>Answered</span> : null;
  }
  function renderCard(entry: HomeFeedEntry, retained = false) {
    const key = keyOf(entry);
    const context = contextFor(entry);
    const unsupported = isTypedPayload(entry) && !context;
    const open = expanded.has(key);
    // A snoozed card rests as its title until the owner asks to answer it now.
    const resting = snoozedNow(entry, clock) && !awake.has(key) && !open;
    const reference = <Reference title={homeFeedKey(entry)}>{humanFeedReference(entry, entries)}</Reference>;
    return <li key={key} className="min-w-0">
      <FeedCardView card={cardView(entry)} sample={false} readBody={source.readBody} now={clock} heading="h3" chip={chipFor(entry)} expanded={open} compact={resting || unsupported} clampTitle={view === "done" || !needing(entry)} onToggle={() => toggle(entry)} onEngage={() => engage(entry)}>
        {resting && <QuietRow><button type="button" className={quietClass} onClick={() => { engage(entry); setAwake((current) => new Set(current).add(key)); }}>Answer now</button></QuietRow>}
        {!resting && <>
        {retained && <div role="status" className="mt-3 flex flex-wrap items-center gap-x-3 text-[13px] text-muted-foreground"><span>A newer version of this card arrived. Answer it there; your draft stays here.</span><button type="button" className={quietClass} onClick={() => release(entry)}>Show the newer version</button></div>}
        <ReportLink entry={entry} />
        {context
          ? <SitrepCard key={key} entry={entry} record={context.record} records={context.records} entries={context.entries} owner={context.owner} projection={context.projection} source={source} now={clock} expanded={open} stale={retained} reference={reference} onSaved={onSaved} onOwnerSaved={() => refreshRef.current()} onSnoozed={release} onNavigate={(next) => { setActive(next); setExpanded((current) => new Set(current).add(keyOf(next))); }} />
          : unsupported
            ? <p role="status" className="mt-3.5 text-sm">This card can't be shown here yet. Your agent still has it.</p>
            : <AnswerForm key={key} entry={entry} source={source} now={clock} attention={attention(entry)} expanded={open} stale={retained} reference={reference} onSaved={onSaved} onSnooze={snooze} />}
        </>}
      </FeedCardView>
    </li>;
  }
  function renderRow(row: Row) {
    if (row.kind === "card") return renderCard(row.item, row.retained);
    const first = row.items[0]; const record = first && contextFor(first)?.record; const name = record && cardGroup(record);
    if (!first || !name) throw new Error("Invalid grouped Home card");
    const open = expandedGroups.has(row.name);
    const pinned = groupPriorityFlag(contextFor(first)?.owner.groupPriority?.groups[name], row.items.map((entry) => { const context = contextFor(entry); return !!context && !!cardPriority(context.record, context.projection.state?.priority); }));
    return <li key={row.name}>
      <section aria-label={`Card group ${name}`} className="rounded-[20px] bg-muted/50 p-2">
        <div className="flex flex-wrap items-center gap-x-3 px-2">
          <button type="button" className={`min-h-11 grow text-left text-[15px] font-semibold ${focusRing}`} aria-expanded={open} onClick={() => setExpandedGroups((previous) => { const next = new Set(previous); if (next.has(row.name)) next.delete(row.name); else next.add(row.name); return next; })}>{name} <span className="font-normal tabular-nums text-muted-foreground">{row.items.length} cards</span></button>
          <button type="button" disabled={viewBusy} aria-pressed={pinned} className={quietClass} onClick={() => void saveGroup(first, name, !pinned)}>{pinned ? "Clear priority" : "Mark priority"}</button>
        </div>
        {open && <ul className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-3">{row.items.map((entry) => renderCard(entry))}</ul>}
      </section>
    </li>;
  }
  const rowNeeds = (row: Row) => (row.kind === "card" ? [row.item] : row.items).some(needing);
  function group(label: string, list: Row[], count?: number, hidden = false) {
    if (!list.length) return null;
    const headingId = `home-group-${label.toLowerCase().replace(/\s+/g, "-")}`;
    return <section aria-labelledby={headingId} className="mt-6">
      <h2 id={headingId} className={hidden ? "sr-only" : "mb-2.5 flex gap-1.5 text-[13px] font-semibold leading-none"}>{label}{count !== undefined && <span className="font-normal tabular-nums text-muted-foreground">{count}</span>}</h2>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">{list.map(renderRow)}</ul>
    </section>;
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
  const bare = homeSite && !!snapshot && !snapshot.entries.length && !snapshot.historicalEntries?.length;
  const selectClass = `mt-2 block h-11 w-full rounded-xl bg-background px-3 text-[15px] shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))] ${focusRing}`;
  return <PendingSendContext.Provider value={pendingSends.current}><main className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-background text-foreground" aria-label={homeSite ? NAV_LABEL_HOME : "Feed"}>
    <div className="mx-auto w-full max-w-[672px] min-w-0 px-4 pb-[calc(var(--tc-bottom-chrome)+2rem)] pt-5 sm:px-6 lg:px-8 lg:pt-10">
      <header>
        <h1 className="font-display text-[min(1.75rem,9vw)] font-semibold leading-[2.125rem] tracking-[-0.005em]">{homeSite ? NAV_LABEL_HOME : "Feed"}</h1>
        <p className="mt-1 text-sm leading-[1.45] text-muted-foreground">{snapshot && !bare
          ? <>{needsCount ? <b className="font-semibold text-foreground">{needsCount} {needsCount === 1 ? "needs" : "need"} you.</b> : <b className="font-semibold text-foreground">Nothing needs you.</b>}{today > 0 && ` ${today} ${today === 1 ? "update" : "updates"} today.`}</>
          : "Updates and decisions from your agents."}</p>
      </header>
      {!bare && <div className="mt-4 flex items-center gap-2">
        <div role="group" aria-label="Show" className="flex gap-0.5 rounded-full bg-muted">
          {VIEWS.map((option) => <button key={option.id} type="button" aria-pressed={view === option.id} onClick={() => changeView(option.id)}
            className={`h-11 whitespace-nowrap rounded-full px-4 text-sm font-medium aria-pressed:bg-background aria-pressed:font-semibold aria-pressed:shadow-[inset_0_0_0_2px_hsl(var(--foreground))] ${focusRing}`}>
            {option.label}{option.id === "needs-you" && snapshot && <span className="ml-1 tabular-nums">{needsCount}</span>}
          </button>)}
        </div>
        {(agents.length > 1 || projects.length > 1 || filtering) && <button type="button" aria-haspopup="dialog" aria-label={`Filter by agent or project${activeFilters ? `, ${activeFilters} active` : ""}`} onClick={() => setFilterOpen(true)}
          className={`relative ml-auto grid size-11 shrink-0 place-items-center rounded-full shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))] ${focusRing}`}>
          <SlidersHorizontalIcon aria-hidden className="size-5" />
          {!!activeFilters && <span aria-hidden className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-foreground px-1 text-[11px] font-semibold tabular-nums text-background">{activeFilters}</span>}
        </button>}
      </div>}
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
      {snapshot && !filteredCount && (bare
        ? <section aria-labelledby="home-empty-title" className={`mt-6 ${cardClass}`}>
          <h2 id="home-empty-title" className="font-display text-[1.375rem] font-normal leading-[1.2]">{HOME_EMPTY_TITLE}</h2>
          <p className="mt-2 max-w-[60ch] text-base leading-[1.5]">{HOME_EMPTY_BODY}</p>
          <AgentPrompt copyButton={({ onClick, children }) => <button type="button" className={primaryPillClass} onClick={onClick}>{children}</button>}
            aside={<a href={FEED_SKILL_URL} target="_blank" rel="noopener noreferrer" className={quietClass}>{HOME_EMPTY_HOW}</a>} />
        </section>
        : <div className="mt-6 rounded-[20px] px-[18px] py-4 text-[15px] text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]">
          <p>{filtering ? "No cards match this filter." : history ? "Nothing answered or snoozed yet." : view === "needs-you" ? "Nothing needs you right now." : "No cards yet."}</p>
          {filtering && <button type="button" className={`mt-2 ${pillClass} text-foreground`} onClick={() => setFilter(() => { setAgent(""); setKind(""); setProject(""); })}>Clear filter</button>}
        </div>)}
      {!!filteredCount && (view === "all"
        ? <>{group("Needs you", rows.filter(rowNeeds), needsCount)}{group("Earlier", rows.filter((row) => !rowNeeds(row)))}</>
        : group(view === "done" ? "Done" : "Needs you", rows, undefined, true))}
    </div>
  </main></PendingSendContext.Provider>;
}
