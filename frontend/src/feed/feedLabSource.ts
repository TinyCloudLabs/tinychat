// The feed lab's feed (FeedLab.tsx): seven made-up cards and a simulated agent, held in
// memory, in the shapes the real source returns (feedStore.ts, loadTypedFeed.ts).
// Nothing is read from or written to any space, server or browser storage. Each
// made-up agent says what it runs on (payload.agent), except Backup agent, which
// says nothing, so a card without a platform can be seen too.
import type { FeedCard, FeedHandling, FeedResponse, FeedResponseHandling, FeedResponsePayload, FeedSelector, FeedSource, NewFeedMessage, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { compactStamp, emptySitrepOwnerData, mergeSitrepStates, ownerThreadResponseKey, parseSitrepCardPayload, safeSitrepActionSummary, validateSitrepAction, type AskOption, type SamState, type SitrepHeldNote, type ThreadMessage } from "@tinyboilerplate/core/feed/sitrep";
import { ownerCardKey } from "./feedIdentity";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource, HomeFeedViewEvent } from "./feedStoreTypes";
import { addCanonicalOwnerEvent, combineOwnerData } from "./sitrepOwnerStore";

/** A save takes this long, so its "in progress" state can be seen. */
export const LAB_SAVE_MS = 600;
/** After an answer is saved, the simulated agent records "acknowledged", then "succeeded". */
export const LAB_RECEIVED_MS = 1_500;
export const LAB_COMPLETED_MS = 6_000;
export const LAB_OUTCOME = "Done. The simulated agent acted on your answer.";
/** After a reply is saved, the simulated agent receives it, then answers in the card's conversation. */
export const LAB_REPLY_RECEIVED_MS = 1_000;
export const LAB_REPLY_MS = 2_000;
export const labReplyText = (text: string) => `Got it. I’ll act on “${text.length > 80 ? `${text.slice(0, 80)}…` : text}” and tell you here.`;

/** `route`: the agents the person approved a link to for the card's owner, as an owner archive supplies them. */
interface LabCard { source: FeedSource; card: FeedCard; route?: NonNullable<HomeFeedEntry["recipientRoute"]> }

function agent(token: string, label: string): FeedSource {
  const database = (side: string) => ({ spaceId: "feed-lab", database: `xyz.tinycloud.tinychat/feed/feed_${side}_lab${token}` });
  return { sourceId: `lab-${token}`, agentDid: `did:key:feed-lab-${token}`, label, output: database("output"), responses: database("responses") };
}

function labCards(now: number): LabCard[] {
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const trip = agent("trip", "Trip agent");
  const home = agent("home", "Home agent");
  const backup = agent("backup", "Backup agent");
  const studio = agent("studio", "Studio agent");
  // One connection that posts for a crew: the card names the crew member it is from.
  const crew = agent("crew", "Studio crew");
  // What each agent reports about itself, as a card's payload.agent.
  type About = { agent: { kind: string; model?: string; runsOn?: string } };
  const codex: About = { agent: { kind: "codex", model: "GPT-5.2-Codex", runsOn: "Your laptop" } };
  const grok: About = { agent: { kind: "grok", model: "Grok 5", runsOn: "Grok Bot, in xAI's cloud" } };
  const claude: About = { agent: { kind: "claude", model: "Claude Opus 5.5", runsOn: "The studio's Mac mini" } };
  const muse: About = { agent: { kind: "muse", runsOn: "WhatsApp" } };
  const kiln = { recipientKey: "lab-kiln", legacyName: "Kiln agent", runtimeTarget: { agentId: "lab-kiln-agent" } };
  const plain = (cardId: string, urgency: number, minutes: number, card: Pick<FeedCard, "kind" | "needsResponse" | "title" | "body" | "choices" | "payload">): FeedCard => ({ cardId, revision: 1, issuanceId: "lab-1", urgency, createdAt: at(minutes), ...card });
  // A typed card as its agent publishes it: the record in payload.sitrep, its title, body and options on the card.
  const typed = (cardId: string, urgency: number, minutes: number, record: { kind: string; title: string; body: string; options?: AskOption[] } & Record<string, unknown>, about: About = claude): FeedCard => {
    const createdAt = at(minutes);
    return {
      cardId, revision: 1, issuanceId: "lab-1", kind: record.kind, needsResponse: true, title: record.title, body: record.body, urgency, createdAt,
      ...(record.options ? { choices: record.options.map(({ id, label }) => ({ id, label })) } : {}),
      payload: { ...about, sitrep: { version: 1, record: { from: studio.label, urgency, importance: 3, links: [], createdAt, updatedAt: createdAt, ...record } } },
    };
  };
  return [
    { source: trip, card: plain("lab-train", 5, -4, {
      kind: "question", needsResponse: true, title: "Which train should I hold for Friday?",
      body: "Two trains reach the workshop before it starts at 14:00. Holding a seat is free until Thursday.",
      choices: [{ id: "direct", label: "08:15 direct" }, { id: "change", label: "09:40, one change" }], payload: codex,
    }) },
    { source: home, card: plain("lab-filter", 4, -35, {
      kind: "question", needsResponse: true, title: "The water filter order renews tomorrow. Keep it?",
      body: "It has renewed every two months since spring. The last filter is still unopened.",
      choices: [{ id: "renew", label: "Renew" }, { id: "skip", label: "Skip this one" }, { id: "stop", label: "Stop it" }], payload: grok,
    }) },
    { source: backup, card: plain("lab-backup", 1, -90, {
      kind: "update", needsResponse: false, title: "Weekly backup finished",
      body: "312 new photos and 18 documents are stored. Nothing needs you.",
    }) },
    { source: studio, card: typed("lab-letter", 3, -20, {
      kind: "ask", id: "newsletter-version", title: "Which version of the spring newsletter goes out?", body: "Both drafts are finished and checked.",
      askedAt: at(-20), status: "open", expiresAt: "never", recommend: "short",
      options: [
        { id: "short", label: "Short version", detail: "Three paragraphs and the dates. Ready to send today." },
        { id: "long", label: "Long version", detail: "Adds the member interview. Needs one more day of edits." },
      ],
      context: {
        background: "The spring newsletter has two finished drafts. The short one covers the open day and the new opening hours; the long one adds an interview with a member.",
        whyNow: "The mailing is booked for tomorrow morning, so the choice is needed today.",
        ifNoAnswer: "The short version goes out tomorrow at 09:00.",
        known: ["The last three newsletters were short, and about half the list opened them."], related: [],
      },
    }) },
    { source: studio, card: typed("lab-room", 3, -50, {
      kind: "ask", id: "workshop-room", title: "Which room should I book for the pottery workshop?", body: "Fourteen people have signed up so far.",
      askedAt: at(-50), status: "open", expiresAt: "never", recommend: "hall", deadline: at(2 * 24 * 60),
      options: [
        { id: "loft", label: "The loft", detail: "Seats 12, good light, two flights of stairs.", cost: "40 per evening" },
        { id: "hall", label: "The hall", detail: "Seats 30, step-free, shared with the choir until 18:00.", cost: "65 per evening" },
        { id: "wait", label: "Wait a week", detail: "Ask again once sign-ups close." },
      ],
      context: {
        background: "The pottery workshop runs for four evenings next month. Two rooms are free on those dates, and each holds its booking for two more days.",
        whyNow: "Both rooms release their hold in two days, and sign-ups already exceed the loft's seats.",
        ifNoAnswer: "No room is booked and the workshop dates stay provisional.",
        known: ["Sign-ups close in one week."], related: [],
      },
    }) },
    { source: studio, card: typed("lab-prices", 2, -10, {
      kind: "approval", id: "price-list-go", title: "Publish the spring price list", body: "Two prices changed; the rest are as they were.",
      approvalType: "go", approvalKind: "publish", codeExpected: false, issuedAt: at(-10), expiresAt: at(3 * 24 * 60), status: "open",
      permissions: "Publishing replaces the price list on the studio's page for everyone.",
      steps: ["Read the two changed prices: glazing goes up by 2, firing stays the same.", "Give the go when they are right."],
      context: {
        background: "The spring price list is drafted and checked against last season's. Only the glazing price changed; the page still shows the winter list.",
        whyNow: "Spring bookings open in three days and should show the new prices.",
        ifNoAnswer: "The winter price list stays on the page.",
        known: [], related: [],
      },
    }) },
    // The person approved a link to Kiln agent, so a reply goes straight to it rather than through Studio crew.
    { source: crew, route: { recipients: [kiln], unresolved: [], receiptRecipients: [kiln] }, card: typed("lab-glaze", 3, -15, {
      kind: "ask", id: "open-day-glaze", from: "Kiln agent", title: "Which glaze should the open-day mugs get?", body: "Forty mugs are bisque-fired and ready to glaze.",
      askedAt: at(-15), status: "open", expiresAt: "never", recommend: "celadon",
      options: [
        { id: "celadon", label: "Celadon", detail: "Pale green, the studio's usual. Glaze firing on Tuesday." },
        { id: "speckled", label: "Speckled white", detail: "New for spring. Needs one test firing first, so Thursday." },
      ],
      context: {
        background: "The mugs are for the open day in two weeks. Both glazes are in stock.",
        whyNow: "The kiln is booked from Tuesday; a test firing has to go in before then.",
        ifNoAnswer: "The mugs get celadon on Tuesday.",
        known: [], related: [],
      },
    }, muse) },
  ];
}

/** `stop` cancels the simulated agent's pending work; the lab calls it when it resets or closes. */
export function createFeedLabSource(now = Date.now()): HomeFeedSource & { stop(): void } {
  const cards = labCards(now);
  const saved: { response: FeedResponse; payload?: FeedResponsePayload }[] = [];
  const handling = new Map<string, FeedResponseHandling>();
  const views = new Map<string, { seenAt?: string; snoozedUntil?: string; events: HomeFeedViewEvent[] }>();
  const states = new Map<string, { eventId: string; state: SamState }[]>();
  const heldNotes = new Map<string, SitrepHeldNote[]>();
  // The simulated agent's replies, by card, as the real feed attaches its output cards (feedStore.ts).
  const replies = new Map<string, ThreadMessage[]>();
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let defaultSelector: FeedSelector = "needs-action";

  const keyOf = (entry: HomeFeedEntry) => ownerCardKey(entry.source.sourceId, entry.state.card);
  const viewOf = (key: string) => views.get(key) ?? views.set(key, { events: [] }).get(key)!;
  function later(ms: number, work: () => void) {
    const timer = setTimeout(() => { timers.delete(timer); work(); }, ms);
    timers.add(timer);
  }
  const wait = (ms: number) => new Promise<void>((resolve) => later(ms, resolve));
  function notify() { for (const listener of listeners) listener(); }

  function entryOf({ source, card, route }: LabCard): HomeFeedEntry {
    const key = ownerCardKey(source.sourceId, card);
    const history = saved.filter(({ response }) => ownerCardKey(source.sourceId, response) === key);
    const latest = history.filter(({ response }) => response.kind !== "message").at(-1)?.response ?? null;
    const receipt = latest ? handling.get(latest.responseId) : undefined;
    const view = viewOf(key);
    const entry: HomeFeedEntry = {
      source, currentIssuance: true,
      state: { card, response: latest, acknowledgement: receipt?.acknowledgement ?? null, outcome: receipt?.outcome ?? null },
      view: { sourceId: source.sourceId, cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, ...(view.seenAt ? { seenAt: view.seenAt } : {}), ...(view.snoozedUntil ? { snoozedUntil: view.snoozedUntil } : {}) },
      responses: history.map(({ response }) => response), viewEvents: view.events,
    };
    const typed = parseSitrepCardPayload(card.payload?.sitrep);
    if (!typed) return entry;
    // As loadTypedFeed.ts: the owner's typed history, each response's receipt, and seen and snoozed in the owner state.
    const owner = emptySitrepOwnerData();
    for (const event of states.get(key) ?? []) {
      owner.states.push(event.state);
      if (event.state.doneAt || event.state.lift || event.state.clears?.length) (owner.commands ??= []).push(event);
    }
    if (heldNotes.has(key)) owner.heldNotes = heldNotes.get(key);
    // As loadTypedFeed.ts: each message keeps the route it was sent on.
    const threadRoutes: NonNullable<HomeFeedEntry["threadRoutes"]> = {};
    for (const { response, payload } of history) {
      const decoded = payload && addCanonicalOwnerEvent(owner, entry, response, payload);
      if (decoded) threadRoutes[ownerThreadResponseKey(decoded.message)] = decoded.delivery ? { kind: "recipients", delivery: decoded.delivery } : { kind: "publisher" };
    }
    for (const reply of replies.get(key) ?? []) {
      owner.threads.push(reply);
      (owner.threadOrigins ??= {})[ownerThreadResponseKey(reply)] = { kind: "agent-output", sourceId: source.sourceId, cardId: `lab-reply-${reply.messageId}`, revision: 1, issuanceId: "lab-1" };
    }
    const state: SamState = mergeSitrepStates(owner.states, "provided")[0] ?? { kind: typed.record.kind, id: typed.record.id, steps: {}, updatedAt: view.seenAt ?? card.createdAt };
    const snoozes = view.events.flatMap((event) => event.kind === "snoozed" && event.snoozedUntil ? [{ at: event.createdAt, until: event.snoozedUntil }] : []);
    if (owner.states.length || view.seenAt || snoozes.length) owner.states = [{ ...state, ...(view.seenAt ? { seenAt: view.seenAt } : {}), ...(snoozes.length ? { snoozedUntil: view.snoozedUntil ?? null, snoozes } : {}) }];
    const receipts = history.flatMap(({ response }) => { const reported = handling.get(response.responseId); return reported ? [[response.responseId, reported] as const] : []; });
    return { ...entry, owner: combineOwnerData([owner]), responseHandling: Object.fromEntries(receipts), threadRoutes, historicalCommands: [], ...(route ? { recipientRoute: structuredClone(route) } : {}) };
  }

  async function store(entry: HomeFeedEntry, response: NewFeedResponse | NewFeedMessage, payload?: FeedResponsePayload): Promise<FeedResponse> {
    if (payload?.type.startsWith("sitrep.")) {
      const typed = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
      if (!typed || payload.version !== 1) throw new Error("Unsupported typed Home response");
      response = { ...response, text: safeSitrepActionSummary(validateSitrepAction(typed.record, payload.type, payload.data, new Date().toISOString())) };
    }
    await wait(LAB_SAVE_MS);
    const stored: FeedResponse = { ...response, sequence: saved.length + 1, ...(payload ? { payloadType: payload.type, payloadVersion: payload.version } : {}) };
    saved.push({ response: stored, ...(payload ? { payload } : {}) });
    return stored;
  }
  function report(response: FeedResponse, phase: FeedHandling["phase"], detail?: FeedHandling["detail"]) {
    const record: FeedHandling = { cardId: response.cardId, revision: response.revision, issuanceId: response.issuanceId, responseId: response.responseId, handlingId: crypto.randomUUID(), phase, createdAt: new Date().toISOString(), ...(detail ? { detail } : {}) };
    const previous = handling.get(response.responseId) ?? { acknowledgement: null, outcome: null };
    handling.set(response.responseId, phase === "acknowledged" ? { ...previous, acknowledgement: record } : { ...previous, outcome: record });
    notify();
  }

  return {
    async load(focused) {
      const entries = cards.map(entryOf);
      const focusedEntry = focused ? entries.find((entry) => keyOf(entry) === keyOf(focused)) : undefined;
      const snapshot: HomeFeedSnapshot = { entries, historicalEntries: [], settings: { defaultSelector }, sitrep: combineOwnerData(entries.flatMap((entry) => entry.owner ? [entry.owner] : [])), relatedEntries: [], ...(focusedEntry ? { focusedEntry } : {}) };
      return structuredClone(snapshot);
    },
    async saveResponse(entry, response, payload) {
      const stored = await store(entry, response, payload);
      later(LAB_RECEIVED_MS, () => report(stored, "acknowledged"));
      later(LAB_COMPLETED_MS, () => report(stored, "succeeded", { message: LAB_OUTCOME }));
      return stored;
    },
    async sendMessage(entry, message, payload) {
      const stored = await store(entry, message, payload);
      const typed = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
      const sent = payload?.type === "sitrep.thread" ? payload.data as { text?: unknown; messageId?: unknown } : undefined;
      if (typed && typeof sent?.text === "string" && typeof sent.messageId === "string") {
        const { text, messageId } = sent;
        later(LAB_REPLY_RECEIVED_MS, () => report(stored, "acknowledged"));
        later(LAB_REPLY_MS, () => {
          const at = new Date().toISOString();
          const reply: ThreadMessage = { side: "officer", kind: typed.record.kind, id: typed.record.id, at, from: typed.record.from, text: labReplyText(text), replyTo: messageId, messageId: `${compactStamp(at)}-${crypto.randomUUID().replace(/-/g, "")}` };
          replies.set(keyOf(entry), [...(replies.get(keyOf(entry)) ?? []), reply]);
          notify();
        });
      }
      return stored;
    },
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
    stop() { for (const timer of timers) clearTimeout(timer); timers.clear(); },
  };
}
