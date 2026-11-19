// The Home feed with every card type (payload.type) and two Courier messages (payload.channel), on made-up cards: one
// card per type, a Courier question and a Courier update from other teams, a card that only claims to be a Courier
// message, and one card that names no type. The two Courier messages come from the Courier connection (the source
// registered under Courier's token, read from that token's database, held here by Wren), so they carry the mark; the
// claim comes from Juniper, so it shows as Juniper's own card. All of it is invented for the harness; nothing here is anyone's real feed.
import { FeedViewEntries } from "@/feed/FeedView";
import { COURIER_SOURCE_ID } from "@/feed/feedData";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "@/feed/feedStoreTypes";
import type { HarnessScreen } from "../screen";

type LabAgent = "atlas" | "juniper" | typeof COURIER_SOURCE_ID;
interface LabCard {
  id: string; agent: LabAgent; title: string; body: string; minutesAgo: number;
  choices?: string[]; payload?: Record<string, unknown>; urgency?: number;
}

/** Each source's registry label. The Courier connection's is the agent that holds it. */
const AGENTS: Record<LabAgent, string> = { atlas: "Atlas", juniper: "Juniper", [COURIER_SOURCE_ID]: "Wren" };

const CARDS: LabCard[] = [
  { id: "spend", agent: "atlas", title: "Renew the design tool for a year at the team price?", body: "The monthly plan ends Friday. The yearly plan costs less over twelve months.", minutesAgo: 12, choices: ["Renew yearly", "Stay monthly"], payload: { type: "spend", priority: 1 }, urgency: 3 },
  { id: "publish", agent: "juniper", title: "Publish the 0.15 changelog on the website?", body: "The draft is checked. It goes live on the public changelog page.", minutesAgo: 35, choices: ["Publish", "Hold"], payload: { type: "publish" } },
  { id: "send", agent: "atlas", title: "Send the follow-up note to the venue in your name?", body: "It confirms the date and asks for the floor plan.", minutesAgo: 50, choices: ["Send it", "Let me edit"], payload: { type: "send", deadline: new Date(Date.now() + 20 * 3_600_000).toISOString() } },
  { id: "access", agent: "juniper", title: "Give the new reviewer read access to the docs space?", body: "Read only, for two weeks.", minutesAgo: 70, choices: ["Give access", "No"], payload: { type: "access" } },
  { id: "rule", agent: "atlas", title: "Always take patch updates without asking?", body: "Only patch versions, only when every check passes.", minutesAgo: 95, choices: ["Always", "Keep asking"], payload: { type: "rule" } },
  { id: "ship", agent: "juniper", title: "Ship build 214 to the beta testers?", body: "Internal beta only. Every check passed.", minutesAgo: 120, choices: ["Ship", "Wait"], payload: { type: "ship" } },
  { id: "do", agent: "atlas", title: "Sign the delivery form at the front desk", body: "Only you can sign it. Tap Done once it's signed.", minutesAgo: 150, choices: ["Done", "Later"], payload: { type: "do" } },
  { id: "review", agent: "juniper", title: "Review the onboarding screens draft", body: "Four screens. Accept them or say what to change.", minutesAgo: 180, choices: ["Accept", "Ask for changes"], payload: { type: "review" } },
  { id: "direction", agent: "atlas", title: "Which way for the search rewrite?", body: "A keeps the index we have. B starts a new one and is faster later.", minutesAgo: 210, choices: ["A: keep the index", "B: new index"], payload: { type: "direction" } },
  { id: "answer", agent: "juniper", title: "Which address should invoices go to?", body: "The supplier asks for one billing address.", minutesAgo: 240, choices: ["The office", "Home"], payload: { type: "answer" } },
  { id: "courier-ask", agent: COURIER_SOURCE_ID, title: "Can we move Thursday's review to Friday morning?", body: "Our team lead is out on Thursday. Friday 10:00 works for us.", minutesAgo: 20, choices: ["Friday works", "Keep Thursday"], payload: { type: "answer", channel: "courier", source: { label: "Mira · Northwind team" } }, urgency: 2 },
  { id: "news", agent: "atlas", title: "Nightly backup finished: three spaces checked", body: "Nothing is missing. The next backup runs tonight.", minutesAgo: 40, payload: { type: "news" } },
  { id: "alert", agent: "juniper", title: "Calendar sync stops tomorrow: its sign-in expires", body: "Sign in again in Settings to keep it running.", minutesAgo: 55, payload: { type: "alert" } },
  { id: "courier-news", agent: COURIER_SOURCE_ID, title: "The shared test data is refreshed", body: "Nothing to do. The new set is in the usual folder.", minutesAgo: 80, payload: { type: "news", channel: "courier", source: { label: "Tomas · Harbor team" } } },
  // A spoof: Juniper writes channel courier and a sender, but isn't the Courier connection, so this is Juniper's card.
  { id: "courier-spoof", agent: "juniper", title: "Share the team folder with the Northwind team?", body: "Made up to test the rule: this card says it came over Courier from the Northwind team, but Juniper isn't the Courier connection, so it shows as Juniper's own card.", minutesAgo: 25, choices: ["Share it", "No"], payload: { type: "access", channel: "courier", source: { label: "Mira · Northwind team" } } },
  { id: "untyped", agent: "atlas", title: "The weekly digest is ready", body: "A short summary of the week's cards.", minutesAgo: 100 },
];

function entry(card: LabCard): HomeFeedEntry {
  const createdAt = new Date(Date.now() - card.minutesAgo * 60_000).toISOString();
  return {
    source: {
      sourceId: card.agent, agentDid: `did:key:lab-${card.agent}`, label: AGENTS[card.agent],
      output: { spaceId: "lab", database: `xyz.tinycloud.tinychat/feed/feed_output_${card.agent}` },
      responses: { spaceId: "lab", database: `xyz.tinycloud.tinychat/feed/feed_responses_${card.agent}` },
    },
    state: {
      card: {
        cardId: card.id, revision: 1, issuanceId: "issuance-1", kind: card.choices ? "ask" : "update", needsResponse: !!card.choices,
        title: card.title, body: card.body, urgency: card.urgency ?? 1, createdAt,
        ...(card.choices ? { choices: card.choices.map((label, index) => ({ id: `choice-${index}`, label })) } : {}),
        payload: card.payload ?? {},
      },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: card.agent, cardId: card.id, revision: 1, issuanceId: "issuance-1" },
  } as HomeFeedEntry;
}

function source(): HomeFeedSource {
  const snapshot = { entries: CARDS.map(entry), settings: { defaultSelector: "both" } } as HomeFeedSnapshot;
  const quiet = async () => {};
  return {
    async load() { return structuredClone(snapshot); },
    async saveResponse(_entry: unknown, response: Record<string, unknown>) { return { ...response, sequence: 1 }; },
    markSeen: quiet, snooze: quiet, setDefaultSelector: quiet,
    subscribe() { return () => {}; },
  } as unknown as HomeFeedSource;
}

export const homeFeedCardTypesScreens: HarnessScreen[] = [
  { id: "home-feed-card-types", group: "homeFeedCardTypes", layout: "document", interactive: true, render: () => <FeedViewEntries realEntries={[]} source={source()} /> },
];
