// The feed lab's other feed (FeedLab.tsx): real rows exported from a test feed with the CLI, held in memory, in the
// shapes the real source returns (feedStore.ts, loadTypedFeed.ts). The export is read once; what you do here (answers,
// comments, seen, snoozed) stays in memory and is never sent. No agent replies: the rows are what the agents published.
import { feedCardSchema, feedHandlingSchema, newFeedMessageSchema, newFeedResponseSchema, type FeedCard, type FeedCardIdentity, type FeedResponse, type FeedResponseHandling, type FeedResponsePayload, type FeedSelector, type FeedSource, type NewFeedMessage, type NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { emptySitrepOwnerData, mergeSitrepStates, ownerThreadResponseKey, parseSitrepCardPayload, safeSitrepActionSummary, validateSitrepAction, type SamState, type SitrepHeldNote } from "@tinyboilerplate/core/feed/sitrep";
import { ownerCardKey } from "./feedIdentity";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource, HomeFeedViewEvent } from "./feedStoreTypes";
import { isReplyOnlyRevision, storedRevisionEntry } from "./replyOnlyRevision";
import { addCanonicalOwnerEvent, combineOwnerData } from "./sitrepOwnerStore";

type Row = Record<string, unknown>;
/** The part of the SDK's zod schemas used here; zod isn't a dependency of this package. */
interface Schema<T> { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } }

function agent(token: string, label: string): FeedSource {
  const database = (side: string) => ({ spaceId: "feed-lab-json", database: `xyz.tinycloud.tinychat/feed/feed_${side}_${token}` });
  return { sourceId: token, agentDid: `did:key:feed-lab-${token}`, label, output: database("output"), responses: database("responses") };
}

function isRow(value: unknown): value is Row { return !!value && typeof value === "object" && !Array.isArray(value); }
function rowsOf(data: Row, field: string): Row[] {
  const value = data[field];
  if (!Array.isArray(value)) throw new Error(`the export has no "${field}" list`);
  return value.map((row, index) => { if (!isRow(row)) throw new Error(`${field}[${index}] isn't an object`); return row; });
}
function parsed<T>(schema: Schema<T>, value: unknown, where: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Error(`${where} isn't valid${issue ? ` (${issue.path.join(".") || "row"}: ${issue.message})` : ""}`);
}
function sequenceOf(row: Row, where: string): number {
  if (typeof row.sequence !== "number" || !Number.isFinite(row.sequence)) throw new Error(`${where} has no sequence`);
  return row.sequence;
}

/**
 * A HomeFeedSource over a test feed's export (`{ exportedAt, agents, cards, revisions, responses, handling }`, every
 * row tagged with its agent's token). Throws a readable Error when `data` isn't such an export.
 */
export function createFeedLabJsonSource(data: unknown): HomeFeedSource & { stop(): void; exportedAt: string } {
  if (!isRow(data)) throw new Error("the JSON isn't a feed export object");
  if (typeof data.exportedAt !== "string" || !data.exportedAt) throw new Error("the export has no exportedAt");
  const exportedAt = data.exportedAt;

  const sources = new Map<string, FeedSource>();
  rowsOf(data, "agents").forEach((row, index) => {
    if (typeof row.token !== "string" || !row.token) throw new Error(`agents[${index}] has no token`);
    if (typeof row.label !== "string") throw new Error(`agents[${index}] has no label`);
    if (sources.has(row.token)) throw new Error(`agents[${index}] repeats token "${row.token}"`);
    sources.set(row.token, agent(row.token, row.label));
  });
  const tokenOf = (row: Row, where: string) => {
    if (typeof row.agent !== "string" || !sources.has(row.agent)) throw new Error(`${where} names agent ${JSON.stringify(row.agent)}, which isn't in agents`);
    return row.agent;
  };

  // Every revision of each card, from `cards` and `revisions`. The schema drops `agent` and `sequence`.
  const revisions = new Map<string, { token: string; cards: Map<number, FeedCard> }>();
  for (const field of ["cards", "revisions"]) {
    rowsOf(data, field).forEach((row, index) => {
      const where = `${field}[${index}]`;
      const token = tokenOf(row, where);
      const card = parsed(feedCardSchema, row, where);
      const key = JSON.stringify([token, card.cardId]);
      const known = revisions.get(key) ?? revisions.set(key, { token, cards: new Map() }).get(key)!;
      known.cards.set(card.revision, card);
    });
  }

  // Responses and handling are bound to the exact revision and issuance they were made on. An agent answers a comment
  // by publishing the card again (revision + 1, a new issuance, the reply appended), so, as main's Home feed does, a
  // run of reply-only revisions (replyOnlyRevision.ts) is one card: each revision maps to the first of its run, and
  // the latest revision gets every answer, comment and receipt of the run. Any other change, or a typed card, starts
  // a new run, so a re-issued request starts unanswered.
  const runOf = new Map<string, string>();
  const latest: { token: string; card: FeedCard }[] = [];
  for (const { token, cards } of revisions.values()) {
    const source = sources.get(token)!;
    const ordered = [...cards.values()].sort((a, b) => a.revision - b.revision);
    let run = ""; let previous: FeedCard | undefined;
    for (const card of ordered) {
      const typed = card.payload?.sitrep !== undefined || card.payload?.sitrepThread !== undefined;
      if (!previous || typed || !isReplyOnlyRevision(storedRevisionEntry(source, previous), storedRevisionEntry(source, card))) run = ownerCardKey(token, card);
      runOf.set(ownerCardKey(token, card), run);
      previous = card;
    }
    latest.push({ token, card: ordered.at(-1)! });
  }
  const groupOf = (token: string, identity: FeedCardIdentity) => runOf.get(ownerCardKey(token, identity)) ?? ownerCardKey(token, identity);
  const saved: { group: string; response: FeedResponse; payload?: FeedResponsePayload }[] = [];
  const nextSequence = new Map<string, number>();
  rowsOf(data, "responses")
    .map((row, index) => {
      const where = `responses[${index}]`;
      const token = tokenOf(row, where);
      const sequence = sequenceOf(row, where);
      const { agent: _agent, sequence: _sequence, payloadType, payloadVersion, dispatchBefore: _dispatch, ...header } = row;
      const response: FeedResponse = {
        ...(header.kind === "message" ? parsed(newFeedMessageSchema, header, where) : parsed(newFeedResponseSchema, header, where)), sequence,
        ...(typeof payloadType === "string" ? { payloadType } : {}), ...(typeof payloadVersion === "number" ? { payloadVersion } : {}),
      };
      return { token, response };
    })
    .sort((a, b) => a.response.sequence - b.response.sequence)
    .forEach(({ token, response }) => {
      saved.push({ group: groupOf(token, response), response });
      nextSequence.set(token, Math.max(nextSequence.get(token) ?? 1, response.sequence + 1));
    });

  const handlingKey = (token: string, responseId: string) => JSON.stringify([token, responseId]);
  const handling = new Map<string, FeedResponseHandling>();
  rowsOf(data, "handling")
    .map((row, index) => {
      const where = `handling[${index}]`;
      return { token: tokenOf(row, where), sequence: sequenceOf(row, where), record: parsed(feedHandlingSchema, row, where) };
    })
    .sort((a, b) => a.sequence - b.sequence)
    .forEach(({ token, record }) => {
      const key = handlingKey(token, record.responseId);
      const previous = handling.get(key) ?? { acknowledgement: null, outcome: null };
      handling.set(key, record.phase === "acknowledged" ? { ...previous, acknowledgement: record } : { ...previous, outcome: record });
    });

  const views = new Map<string, { seenAt?: string; snoozedUntil?: string; events: HomeFeedViewEvent[] }>();
  const states = new Map<string, { eventId: string; state: SamState }[]>();
  const heldNotes = new Map<string, SitrepHeldNote[]>();
  const listeners = new Set<() => void>();
  let defaultSelector: FeedSelector = "both";

  const keyOf = (entry: HomeFeedEntry) => ownerCardKey(entry.source.sourceId, entry.state.card);
  const viewOf = (key: string) => views.get(key) ?? views.set(key, { events: [] }).get(key)!;
  function notify() { for (const listener of listeners) listener(); }

  function entryOf({ token, card }: { token: string; card: FeedCard }): HomeFeedEntry {
    const source = sources.get(token)!;
    const key = ownerCardKey(source.sourceId, card);
    const history = saved.filter((item) => item.group === groupOf(token, card));
    const answer = history.filter(({ response }) => response.kind !== "message").at(-1)?.response ?? null;
    const receipt = answer ? handling.get(handlingKey(token, answer.responseId)) : undefined;
    const receipts = Object.fromEntries(history.flatMap(({ response }) => { const reported = handling.get(handlingKey(token, response.responseId)); return reported ? [[response.responseId, reported] as const] : []; }));
    const view = viewOf(key);
    const entry: HomeFeedEntry = {
      source, currentIssuance: true,
      state: { card, response: answer, acknowledgement: receipt?.acknowledgement ?? null, outcome: receipt?.outcome ?? null },
      view: { sourceId: source.sourceId, cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, ...(view.seenAt ? { seenAt: view.seenAt } : {}), ...(view.snoozedUntil ? { snoozedUntil: view.snoozedUntil } : {}) },
      responses: history.map(({ response }) => response), viewEvents: view.events, responseHandling: receipts,
    };
    const typed = parseSitrepCardPayload(card.payload?.sitrep);
    if (!typed) return entry;
    // As loadTypedFeed.ts: the owner's typed history and seen and snoozed in the owner state. Exported responses carry
    // no payloads, so only what is sent here adds typed messages.
    const owner = emptySitrepOwnerData();
    for (const event of states.get(key) ?? []) {
      owner.states.push(event.state);
      if (event.state.doneAt || event.state.lift || event.state.clears?.length) (owner.commands ??= []).push(event);
    }
    if (heldNotes.has(key)) owner.heldNotes = heldNotes.get(key);
    const threadRoutes: NonNullable<HomeFeedEntry["threadRoutes"]> = {};
    for (const { response, payload } of history) {
      const decoded = payload && addCanonicalOwnerEvent(owner, entry, response, payload);
      if (decoded) threadRoutes[ownerThreadResponseKey(decoded.message)] = decoded.delivery ? { kind: "recipients", delivery: decoded.delivery } : { kind: "publisher" };
    }
    const state: SamState = mergeSitrepStates(owner.states, "provided")[0] ?? { kind: typed.record.kind, id: typed.record.id, steps: {}, updatedAt: view.seenAt ?? card.createdAt };
    const snoozes = view.events.flatMap((event) => event.kind === "snoozed" && event.snoozedUntil ? [{ at: event.createdAt, until: event.snoozedUntil }] : []);
    if (owner.states.length || view.seenAt || snoozes.length) owner.states = [{ ...state, ...(view.seenAt ? { seenAt: view.seenAt } : {}), ...(snoozes.length ? { snoozedUntil: view.snoozedUntil ?? null, snoozes } : {}) }];
    return { ...entry, owner: combineOwnerData([owner]), threadRoutes, historicalCommands: [] };
  }

  async function store(entry: HomeFeedEntry, response: NewFeedResponse | NewFeedMessage, payload?: FeedResponsePayload): Promise<FeedResponse> {
    if (payload?.type.startsWith("sitrep.")) {
      const typed = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
      if (!typed || payload.version !== 1) throw new Error("Unsupported typed Home response");
      response = { ...response, text: safeSitrepActionSummary(validateSitrepAction(typed.record, payload.type, payload.data, new Date().toISOString())) };
    }
    const token = entry.source.sourceId;
    const sequence = nextSequence.get(token) ?? 1;
    nextSequence.set(token, sequence + 1);
    const stored: FeedResponse = { ...response, sequence, ...(payload ? { payloadType: payload.type, payloadVersion: payload.version } : {}) };
    saved.push({ group: groupOf(token, stored), response: stored, ...(payload ? { payload } : {}) });
    return stored;
  }

  return {
    exportedAt,
    async load(focused) {
      const entries = latest.map(entryOf);
      const focusedEntry = focused ? entries.find((entry) => keyOf(entry) === keyOf(focused)) : undefined;
      const snapshot: HomeFeedSnapshot = { entries, historicalEntries: [], settings: { defaultSelector }, sitrep: combineOwnerData(entries.flatMap((entry) => entry.owner ? [entry.owner] : [])), relatedEntries: [], ...(focusedEntry ? { focusedEntry } : {}) };
      return structuredClone(snapshot);
    },
    saveResponse: store,
    sendMessage: store,
    async saveOwnerState(entry, event) { states.set(keyOf(entry), [...(states.get(keyOf(entry)) ?? []), structuredClone(event)]); notify(); },
    async saveHeldNote(entry, note) { heldNotes.set(keyOf(entry), [...(heldNotes.get(keyOf(entry)) ?? []), structuredClone(note)]); notify(); },
    async markSeen(entry) {
      const view = viewOf(keyOf(entry));
      view.seenAt = new Date().toISOString();
      view.events.push({ sequence: view.events.length + 1, kind: "seen", createdAt: view.seenAt });
    },
    async snooze(entry, until) {
      const view = viewOf(keyOf(entry));
      view.snoozedUntil = until;
      view.events.push({ sequence: view.events.length + 1, kind: "snoozed", createdAt: new Date().toISOString(), snoozedUntil: until });
    },
    async setDefaultSelector(selector) { defaultSelector = selector; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    stop() { listeners.clear(); },
  };
}
