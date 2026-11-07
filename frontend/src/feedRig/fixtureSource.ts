// Feed design rig: HomeFeedSource implementations over a static
// fixture, so the real Home feed components render every state without a session,
// a node or any network. Answers, snoozes and notes made in the rig live in memory
// and reset on reload.
//
// RIG-ONLY: a message the owner sends on a card gets a canned agent reply about 2 s
// later (fakeAgentReply). This is not app behaviour; the app never fakes replies.
import type { FeedResponse } from "@tinycloud/sdk-services/feed";
import { compactStamp, emptySitrepOwnerData, type SitrepHeldNote, type SitrepOwnerData } from "@tinyboilerplate/core/feed/sitrep";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "@/feed/feedStoreTypes";

const CANNED_REPLIES = [
  "Got it. I'll take that into account and update the card.",
  "Thanks. I'll check and reply here within the hour.",
  "Understood. Nothing changes until you choose.",
];
let replyCount = 0;
function hex(length: number) { return Array.from(crypto.getRandomValues(new Uint8Array(length / 2)), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

/**
 * One rig state. `snapshot` is exactly what HomeFeedSource.load() returns (feed/feedStoreTypes.ts:56-64).
 * `failSaves` makes every answer write fail; `act` is a rig-only step taken after the first render
 * (open the Done view, or pick a filter that matches nothing).
 */
export type RigState =
  | { label: string; kind: "feed"; snapshot: HomeFeedSnapshot; failSaves?: boolean; act?: "done" | "filter-empty" | "signin-toast" }
  | { label: string; kind: "loading" }
  | { label: string; kind: "error"; message: string }
  | { label: string; kind: "signed-out" };

export interface RigFixture {
  states: Record<string, RigState>;
}

const sameCard = (a: HomeFeedEntry, b: HomeFeedEntry) =>
  a.source.sourceId === b.source.sourceId && a.state.card.cardId === b.state.card.cardId
  && a.state.card.revision === b.state.card.revision && a.state.card.issuanceId === b.state.card.issuanceId;

/** An in-memory source over one fixture snapshot. */
export function fixtureSource(initial: HomeFeedSnapshot, options: { failSaves?: boolean } = {}): HomeFeedSource {
  const snapshot: HomeFeedSnapshot = structuredClone(initial);
  const owner = snapshot.sitrep ?? emptySitrepOwnerData();
  snapshot.sitrep = owner;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const stored = (entry: HomeFeedEntry) => snapshot.entries.find((candidate) => sameCard(candidate, entry));
  let sequence = 1000;
  const typedRef = (entry: HomeFeedEntry) => {
    const record = (entry.state.card.payload?.sitrep as { record?: { kind?: unknown; id?: unknown } } | undefined)?.record;
    return { kind: String(record?.kind ?? entry.state.card.kind), id: String(record?.id ?? entry.state.card.cardId) };
  };
  const record = (entry: HomeFeedEntry, response: { responseId: string }, payload?: { type: string; data: unknown }) => {
    if (!payload) return;
    const sourceKey = `owner-response/${response.responseId}`;
    if (payload.type === "sitrep.answer") owner.answers.push({ sourceKey, card: typedRef(entry), value: payload.data } as never);
    if (payload.type === "sitrep.claim") owner.claimDecisions.push({ sourceKey, card: typedRef(entry), value: payload.data } as never);
    if (payload.type === "sitrep.thread") owner.threads.push(payload.data as never);
  };
  /** RIG-ONLY: the agent answers an owner's card message about 2 s later. */
  function fakeAgentReply(entry: HomeFeedEntry, data: unknown) {
    if (!data || typeof data !== "object" || !("kind" in data) || !("id" in data) || !("messageId" in data)) return;
    const { kind, id, messageId } = data;
    window.setTimeout(() => {
      const at = new Date().toISOString();
      owner.threads.push({ side: "officer", kind, id, at, text: CANNED_REPLIES[replyCount++ % CANNED_REPLIES.length]!, from: entry.source.label, replyTo: messageId,
        messageId: `${compactStamp(at)}-${hex(32)}` } as never);
      notify();
    }, 2000);
  }
  const heldNotes = new Map<string, SitrepHeldNote[]>();
  const cardKey = (entry: HomeFeedEntry) => JSON.stringify([entry.source.sourceId, entry.state.card.cardId]);
  /** Each typed card's own owner data, as the real store attaches it (loadTypedFeed's entry.owner). */
  const ownerFor = (entry: HomeFeedEntry): SitrepOwnerData => {
    const ref = typedRef(entry);
    const mine = (value: { kind: string; id: string }) => value.kind === ref.kind && value.id === ref.id;
    return { ...emptySitrepOwnerData(), answers: owner.answers.filter((answer) => mine(answer.card)), claimDecisions: owner.claimDecisions.filter((decision) => mine(decision.card)),
      states: owner.states.filter(mine), threads: owner.threads.filter(mine), heldNotes: heldNotes.get(cardKey(entry)) ?? [] };
  };
  return {
    async load(focused) {
      const loaded = structuredClone(snapshot);
      loaded.entries = loaded.entries.map((entry) => entry.state.card.payload?.sitrep !== undefined && !entry.owner ? { ...entry, owner: structuredClone(ownerFor(entry)) } : entry);
      const match = focused ? loaded.entries.find((entry) => sameCard(entry, focused)) : undefined;
      return match ? { ...loaded, focusedEntry: structuredClone(match) } : loaded;
    },
    async saveResponse(entry, response, payload) {
      if (options.failSaves) throw new Error("Rig: this state refuses every write");
      const saved = { ...response, sequence: ++sequence } as FeedResponse;
      const target = stored(entry);
      if (target) { target.state.response = saved; (target.responses ??= []).push(saved); }
      record(entry, response, payload as { type: string; data: unknown } | undefined);
      notify();
      return saved;
    },
    async sendMessage(entry, message, payload) {
      const saved = { ...message, sequence: ++sequence } as FeedResponse;
      record(entry, message as { responseId: string }, payload as { type: string; data: unknown } | undefined);
      notify();
      if (payload?.type === "sitrep.thread") fakeAgentReply(entry, payload.data);
      return saved;
    },
    async saveOwnerState(_entry, event) { owner.states.push(structuredClone(event.state) as never); notify(); },
    async saveHeldNote(entry, note) { heldNotes.set(cardKey(entry), [...heldNotes.get(cardKey(entry)) ?? [], structuredClone(note)]); notify(); },
    async setGroupPriority() { notify(); },
    async markSeen(entry) { const target = stored(entry); if (target) target.view.seenAt = new Date().toISOString(); },
    async snooze(entry, until) { const target = stored(entry); if (target) target.view.snoozedUntil = until; notify(); },
    async setDefaultSelector(selector) { snapshot.settings.defaultSelector = selector; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** A source whose first load never settles: the "Loading your feed…" state. */
export function loadingSource(): HomeFeedSource {
  // The project's TS lib predates Promise.withResolvers, so the executor form is the one available.
  return { ...fixtureSource({ entries: [], settings: { defaultSelector: "needs-action" } }), load: () => new Promise<HomeFeedSnapshot>(() => {}) };
}

/** A source whose load fails with `message`: the error state. */
export function failingSource(message: string): HomeFeedSource {
  return { ...fixtureSource({ entries: [], settings: { defaultSelector: "needs-action" } }), load: async () => { throw new Error(message); } };
}
