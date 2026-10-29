import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedResponse, FeedSelector, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { FeedCardView } from "./FeedView";
import { safeUrl, type FeedCard } from "./feedData";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { SitrepCard } from "./SitrepCard";
import { typedContexts } from "./sitrepProjection";
import { humanFeedReference, homeFeedKey, homeGroupScope } from "./feedIdentity";
import { cardGroup, cardPriority, compareWaiting, DUE_WINDOW_MS, groupCards, groupPriorityFlag, isClosed, orderPriority, type SitrepProjection } from "@tinyboilerplate/core/feed/sitrep";

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
        <p className="text-xs text-muted-foreground">{response.kind === "message" ? "Message saved" : response.kind === "followup" ? "Follow-up saved" : "Answer saved"} · <time dateTime={response.createdAt}>{new Date(response.createdAt).toLocaleString()}</time></p>
        {response.choiceId && <p>{entry.state.card.choices?.find((choice) => choice.id === response.choiceId)?.label ?? response.choiceId}</p>}
        {response.text && <p className="whitespace-pre-wrap">{response.text}</p>}
        {response.supersedesResponseId && <p className="text-xs text-muted-foreground">Follows response {response.supersedesResponseId}</p>}
      </li>)}
      {snoozes.map((event) => <li key={`snooze-${event.sequence}`} className="text-xs text-muted-foreground">Snoozed at {new Date(event.createdAt).toLocaleString()}{event.snoozedUntil && ` until ${new Date(event.snoozedUntil).toLocaleString()}`}</li>)}
    </ol>
  </details>;
}
function ResponseStatus({ entry }: { entry: HomeFeedEntry }) {
  const { response, acknowledgement, outcome } = entry.state;
  if (!response) return null;
  const received = acknowledgement?.responseId === response.responseId;
  const result = outcome?.responseId === response.responseId ? outcome : null;
  const detail = result?.detail?.message;
  return <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-4 text-sm" role="status" aria-label="Answer status">
    <p className="font-medium">Answer saved{received && " · Agent received"}{result && (result.phase === "succeeded" ? " · Completed" : " · Failed")}</p>
    {response.choiceId && <p>{entry.state.card.choices?.find((choice) => choice.id === response.choiceId)?.label ?? response.choiceId}</p>}
    {response.text && <p className="whitespace-pre-wrap break-words">{response.text}</p>}
    {typeof detail === "string" && <p className="whitespace-pre-wrap break-words">{detail}</p>}
  </div>;
}

function AnswerForm({ entry, source, onSaved }: { entry: HomeFeedEntry; source: HomeFeedSource; onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void }) {
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState(false);
  const pendingResponse = useRef<NewFeedResponse | null>(null);
  const saved = entry.state.response;
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
      pendingResponse.current = null;
      setText(""); setChoice(undefined); setFollowup(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Answer could not be saved");
    } finally { setSaving(false); }
  }
  function editText(value: string) { setText(value); pendingResponse.current = null; }
  if (!entry.state.card.needsResponse) return null;
  return <div className="mt-4 space-y-3">
    <ResponseStatus entry={entry} />
    {saved && !followup ? <button type="button" className="min-h-10 rounded-lg border border-border px-3 text-sm" onClick={() => setFollowup(true)}>Add follow-up</button> : <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-3">
      {saved && <p className="text-xs text-muted-foreground">A follow-up does not cancel an action already received by the agent.</p>}
      {!!entry.state.card.choices?.length && <fieldset disabled={saving} className="flex flex-wrap gap-2">
        <legend className="mb-2 text-sm font-medium">Choose an option</legend>
        {entry.state.card.choices.map((option) => <label key={option.id} className={`inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${choice === option.id ? "border-primary bg-primary/10" : "border-border"}`}>
          <input type="radio" name={`answer-${keyOf(entry)}`} value={option.id} checked={choice === option.id} onChange={() => { setChoice(option.id); pendingResponse.current = null; }} />{option.label}
        </label>)}
      </fieldset>}
      <label className="block text-sm font-medium">Your answer<textarea aria-label="Your answer" value={text} disabled={saving} onInput={(event) => editText(event.currentTarget.value)} className="mt-2 min-h-24 w-full resize-y rounded-xl border border-border bg-background p-3 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <button type="submit" disabled={saving || (!text.trim() && !choice)} className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{saving ? "Saving answer…" : saved ? "Save follow-up" : "Save answer"}</button>
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

export function HomeFeedEntries({ source }: { source: HomeFeedSource }) {
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
    chosenSelector.current = false; hasDefault.current = false;
    committed.current.clear();
    activeRef.current = null;
    setSnapshot(null); setActive(null); setError(null);
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
  const focusedIndex = filtered.findIndex((entry) => keyOf(entry) === focusedKey);
  const nextEntry = filtered.length ? filtered[(focusedIndex + 1) % filtered.length] : undefined;
  useEffect(() => { if (focused && activeKey !== focusedKey) setActive(focused); }, [focusedKey, activeKey]);
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

  function navigationCard(entry: HomeFeedEntry) {
    const context = contextFor(entry);
    const status = context ? context.projection.answer ? " · Answer saved" : context.record.kind === "claim" && context.owner.claimDecisions.some((decision) => decision.card.id === context.record.id) ? " · Decision saved" : context.projection.state?.doneAt ? " · Completion requested" : "" : entry.state.response ? " · Answer saved" : entry.view.snoozedUntil && Date.parse(entry.view.snoozedUntil) > clock ? " · Snoozed" : "";
    return <button type="button" key={keyOf(entry)} aria-current={focusedKey === keyOf(entry) ? "true" : undefined} onClick={() => setActive(entry)} className="min-h-11 w-full rounded-xl border border-border bg-card px-3 py-2 text-left text-sm aria-[current=true]:border-primary"><span className="font-medium">{entry.state.card.title}</span><span className="ml-2 text-xs text-muted-foreground">{entry.source.label} · {entry.state.card.kind}{status}</span></button>;
  }

  async function saveGroup(entry: HomeFeedEntry, group: string, on: boolean) {
    setViewBusy(true); setError(null);
    try {
      if (!source.setGroupPriority) throw new Error("This feed source does not provide private group storage");
      await source.setGroupPriority(entry, group, on); refreshRef.current();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Private group decision could not be saved"); }
    finally { setViewBusy(false); }
  }

  const selectClass = "min-h-10 w-36 max-w-full rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return <main className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-background text-foreground" aria-label="Feed">
    <div className="mx-auto w-full max-w-2xl min-w-0 px-3 pb-[calc(var(--tc-bottom-chrome)+2rem)] pt-6 sm:px-5">
      <header className="mb-6"><h1 className="font-display text-3xl font-semibold tracking-tight">Feed</h1><p className="mt-1 text-sm text-muted-foreground">Updates and decisions from your agents.</p></header>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="home-feed-view">Feed view</label>
        <select id="home-feed-view" aria-label="Feed view" value={selector} className={selectClass} onChange={(event) => changeSelector(event.target.value as FeedSelector)}>
          <option value="information">Information</option><option value="both">Both</option><option value="needs-action">Needs action</option>
        </select>
        <button type="button" disabled={savingDefault || snapshot?.settings.defaultSelector === selector} onClick={() => void saveDefault()} className="min-h-10 rounded-lg border border-border px-3 text-xs disabled:opacity-50">{savingDefault ? "Saving default…" : "Use as default"}</button>
        <button type="button" aria-pressed={history} onClick={() => { setHistory(!history); setActive(null); }} className="ml-auto min-h-10 rounded-lg border border-border px-3 text-sm">History</button>
      </div>
      <div className="mb-5 flex flex-wrap gap-2">
        <select aria-label="Filter by agent" className={selectClass} value={agent} onChange={(event) => { setAgent(event.target.value); setActive(null); }}><option value="">All agents</option>{[...new Map(entries.map((entry) => [entry.source.sourceId, entry.source.label])).entries()].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <select aria-label="Filter by type" className={selectClass} value={kind} onChange={(event) => { setKind(event.target.value); setActive(null); }}><option value="">All types</option>{[...new Set(entries.map((entry) => entry.state.card.kind))].sort().map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <select aria-label="Filter by project" className={selectClass} value={project} onChange={(event) => { setProject(event.target.value); setActive(null); }}><option value="">All projects</option>{[...new Set(entries.map(projectOf).filter(Boolean))].sort().map((value) => <option key={value} value={value}>{value}</option>)}</select>
      </div>
      {error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 p-3 text-sm"><p>{error}</p><button type="button" onClick={() => refreshRef.current()} className="mt-2 min-h-9 underline">Try again</button></div>}
      {!snapshot && !error && <p className="text-sm text-muted-foreground">Loading your feed…</p>}
      {snapshot && !filtered.length && !focused && <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{history ? "No answered or snoozed cards." : selector === "needs-action" ? "Nothing needs your action." : "No cards in this view."}</p>}
      {focused && <section aria-label="Focused card" className="mb-5 min-w-0">
        <FeedCardView card={cardView(focused)} sample={false} readBody={source.readBody} />
        <ReportLink entry={focused} />
        <p className="mt-3 text-xs text-muted-foreground" aria-label="Card reference"><code className="select-all break-all" title={homeFeedKey(focused)}>{humanFeedReference(focused, entries)}</code></p>
        {focusedContext ? <SitrepCard key={focusedKey!} entry={focused} record={focusedContext.record} records={focusedContext.records} entries={focusedContext.entries} owner={focusedContext.owner} projection={focusedContext.projection} source={source} now={clock} onSaved={onSaved} onOwnerSaved={() => refreshRef.current()} onNavigate={setActive} /> : focusedUnsupported ? <p role="status" className="mt-4 rounded-xl border border-border p-3 text-sm">Unsupported typed record or unresolved thread event. Original card preserved; no fallback answer action is available.</p> : <><AnswerForm key={focusedKey!} entry={focused} source={source} onSaved={onSaved} /><CardHistory entry={focused} /></>}
        <div className="mt-4 flex flex-wrap gap-2">
          {!focusedContext && !focusedUnsupported && needsAttention(focused, clock) && <button type="button" disabled={viewBusy} onClick={() => void snooze()} className="min-h-10 rounded-lg border border-border px-3 text-sm disabled:opacity-50">Snooze for 1 hour</button>}
          {nextEntry && keyOf(nextEntry) !== focusedKey && <button type="button" onClick={() => { if (nextEntry) setActive(nextEntry); }} className="min-h-10 rounded-lg border border-border px-3 text-sm">Next card</button>}
        </div>
      </section>}
      {!!filtered.length && <nav aria-label="Cards in this view" className="mb-4 grid max-h-72 gap-2 overflow-y-auto">
        {navigation.map((row) => {
          if (row.kind === "card") return navigationCard(row.item);
          const first = row.items[0]; const record = first && contextFor(first)?.record; const name = record && cardGroup(record);
          if (!first || !name) throw new Error("Invalid grouped Home card");
          const open = expandedGroups.has(row.name);
          const pinned = groupPriorityFlag(contextFor(first)?.owner.groupPriority?.groups[name], row.items.map((entry) => { const context = contextFor(entry); return !!context && !!cardPriority(context.record, context.projection.state?.priority); }));
          return <section key={row.name} aria-label={`Card group ${name}`} className="space-y-2 rounded-xl border border-border p-2">
            <div className="flex flex-wrap items-center gap-2"><button type="button" className="min-h-10 grow px-2 text-left text-sm font-medium" aria-expanded={open} onClick={() => setExpandedGroups((previous) => { const next = new Set(previous); if (next.has(row.name)) next.delete(row.name); else next.add(row.name); return next; })}>{name} · {row.items.length} cards</button><button type="button" disabled={viewBusy} aria-pressed={pinned} className="min-h-10 rounded-lg border border-border px-2 text-xs disabled:opacity-50" onClick={() => void saveGroup(first, name, !pinned)}>{pinned ? "Clear private group priority" : "Mark private group priority"}</button></div>
            {open && <div className="grid gap-2 pl-2">{row.items.map(navigationCard)}</div>}
          </section>;
        })}
      </nav>}
    </div>
  </main>;
}
