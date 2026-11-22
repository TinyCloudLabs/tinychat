// Tiny bots, slice 1 (TC-2808): Home for an account with tiny bots on. The real Home feed (empty, as a
// new test account sees it) under the real navigation, with the ask box on top; then Main's chat over
// it, mid-reply. Synthetic content; nothing is sent anywhere. `bots-home-feed`: the same Home with cards from three
// agents, two of them answered (Sam's top bar, 11-13: the slider beside Filter and View, and Pending at the end).
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";

import { AskBox } from "@/bots/AskBox";
import { CreateBotDialog } from "@/bots/CreateBotDialog";
import { BOTS_STRINGS } from "@/bots/botsStrings";
import type { BotRoster, BotRosterApi, RosterBot } from "@/bots/botRosterApi";
import { useBots } from "@/bots/useBots";
import { BotsRouteMissing, type BotsApi, type SecretRequest } from "@/bots/botsApi";
import { HomeAskBox } from "@/bots/HomeAskBox";
import { MainChat } from "@/bots/MainChat";
import { SecretCards } from "@/bots/SecretCard";
import type { Asks } from "@/bots/useAsks";
import { setSecretsAvailableForTests } from "@/lib/openkeyNative";
import type { MainChatState } from "@/bots/useMainChat";
import { HomeFeedEntries } from "@/feed/HomeFeedEntries";
import type { HomeFeedEntry, HomeFeedSource } from "@/feed/feedStoreTypes";
import { DEFAULT_FEED_VIEW_MODE, saveFeedViewMode, type FeedViewMode } from "@/feed/feedViewMode";
import { setShowHiddenFeatures } from "@/lib/hiddenFeatures";
import { useSizeClass } from "@/lib/sizeClass";
import { cn } from "@/lib/utils";
import { NavRail } from "@/shell/NavRail";
import { navItems, navKindFor } from "@/shell/navItems";
import { Sidebar } from "@/shell/Sidebar";
import { TabBar } from "@/shell/TabBar";
import type { HarnessScreen } from "../screen";
import { FROZEN_NOW } from "../stubs";

const EMPTY_FEED: HomeFeedSource = {
  load: async () => ({ entries: [], settings: { defaultSelector: "needs-action" } }),
  saveResponse: async () => { throw new Error("harness: read-only feed"); },
  markSeen: async () => {},
  snooze: async () => {},
  setDefaultSelector: async () => {},
  subscribe: () => () => {},
};

function card(sourceId: string, label: string, cardId: string, title: string, body: string, minutesAgo: number, answered?: "waiting" | "done", payload?: Record<string, unknown>, urgency = 1): HomeFeedEntry {
  const createdAt = new Date(FROZEN_NOW - minutesAgo * 60_000).toISOString();
  const database = (kind: string) => `xyz.tinycloud.tinychat/feed_${kind}_${sourceId}`;
  const response = answered ? { cardId, revision: 1, issuanceId: `${cardId}-1`, responseId: `${cardId}-answer`, sequence: 1, kind: "answer" as const, choiceId: "yes", createdAt } : null;
  const handling = (phase: "acknowledged" | "succeeded") => ({ cardId, revision: 1, issuanceId: `${cardId}-1`, responseId: `${cardId}-answer`, handlingId: `${cardId}-${phase}`, phase, createdAt });
  return {
    source: { sourceId, agentDid: `did:key:${sourceId}`, label, output: { spaceId: "harness", database: database("output") }, responses: { spaceId: "harness", database: database("responses") } },
    state: {
      card: { cardId, revision: 1, issuanceId: `${cardId}-1`, kind: "ask", needsResponse: true, title, body, urgency, createdAt, choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "Not now" }], ...(payload ? { payload } : {}) },
      response, acknowledgement: answered === "done" ? handling("acknowledged") : null, outcome: answered === "done" ? handling("succeeded") : null,
    },
    view: { sourceId, cardId, revision: 1, issuanceId: `${cardId}-1`, seenAt: createdAt },
  };
}

const FEED: HomeFeedSource = {
  ...EMPTY_FEED,
  load: async () => ({
    entries: [
      card("trip", "Trip agent", "train", "Which train should I hold for Friday?", "08:15 direct or 09:40 with a change.", 12),
      card("home", "House agent", "filter", "The water filter renews tomorrow. Keep it?", "The last filter is still unopened.", 60),
      card("studio", "Studio agent", "room", "Which room for the pottery workshop?", "The loft seats 12, the hall 30.", 180),
      card("trip", "Trip agent", "plan", "Write tomorrow's plan at 09:00?", "A short plan for the day.", 240, "waiting"),
      card("home", "House agent", "backup", "Run the weekly backup now?", "It takes about ten minutes.", 300, "done"),
    ],
    settings: { defaultSelector: "needs-action" },
  }),
};

const inHours = (hours: number) => new Date(FROZEN_NOW + hours * 3_600_000).toISOString();
// Enough cards to tell the three views apart: P0, a deadline, long titles, answered ones. (No P1: a row's P1 badge is a
// 10px label, which the screens' text-size check refuses, so it stays out of the fixtures.)
const MANY: HomeFeedSource = {
  ...EMPTY_FEED,
  load: async () => ({
    entries: [
      card("trip", "Trip agent", "train", "Which train should I hold for Friday?", "08:15 direct or 09:40 with a change.", 12, undefined, { priority: 0, deadline: inHours(3) }, 3),
      card("home", "House agent", "filter", "The water filter renews tomorrow. Keep it?", "The last filter is still unopened.", 60, undefined, undefined, 2),
      card("studio", "Studio agent", "room", "Which room for the pottery workshop on the twenty-first, given that the loft seats twelve and the hall seats thirty?", "The loft seats 12, the hall 30. Eleven people have said yes so far.", 180),
      card("trip", "Trip agent", "hotel", "Book the hotel near the station?", "It is 140 a night with free cancellation until Thursday.", 200, undefined, { deadline: inHours(30) }, 2),
      card("home", "House agent", "boiler", "The boiler service slot moved to Monday morning. Is that fine?", "Someone needs to be home between 8 and 12.", 240),
      card("studio", "Studio agent", "kiln", "Order more clay before the next firing?", "Stock covers about two more sessions.", 300),
      card("trip", "Trip agent", "plan", "Write tomorrow's plan at 09:00?", "A short plan for the day.", 360, "waiting"),
      card("home", "House agent", "backup", "Run the weekly backup now?", "It takes about ten minutes.", 400, "done"),
      card("studio", "Studio agent", "flyer", "Print the flyers in colour or black and white?", "Colour costs about three times as much.", 500, "done"),
      card("home", "House agent", "bins", "Move bin day to Thursday for the holiday week?", "The council posted a change for this week only.", 600),
    ],
    settings: { defaultSelector: "needs-action" },
  }),
};

const ENABLED: BotsApi = {
  getBotsStatus: async () => ({ enabled: true }),
  listMainMessages: async () => [],
  getMainWeb: async () => ({ mode: "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
  setMainWeb: () => new Promise(() => {}),
  sendToMain: () => new Promise(() => {}),
  // This service has no questions route, so the screens show no Main questions.
  getAsks: () => Promise.reject(new BotsRouteMissing()),
  setAsks: () => Promise.reject(new BotsRouteMissing()),
  listRequests: () => Promise.reject(new BotsRouteMissing()),
  answerRequest: () => Promise.reject(new BotsRouteMissing()),
};

const MID_REPLY: MainChatState = {
  history: "loaded",
  lines: [
    { id: "m1", role: "user", text: "Give me three names for a reading group." },
    { id: "m2", role: "bot", text: "Margins, Second Chapter, and The Long Shelf." },
  ],
  turn: {
    text: "Draft a short note to the team: Friday's offsite now starts at 10:00.",
    reply: "Here's a draft:\n\nHi all, a quick change for Friday: the offsite now starts at 10:00 instead of 9:00, same place. Bring",
    state: "working",
  },
};

const GRID = {
  tabbar: "grid-cols-1 grid-rows-[minmax(0,1fr)_auto]",
  rail: "grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
  sidebar: "grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
} as const;

/** The app's navigation around the real Home feed. */
function Home({ ask, source = EMPTY_FEED }: { ask: ReactNode; source?: HomeFeedSource }) {
  const nav = navKindFor(useSizeClass());
  const navProps = { items: navItems(0), current: "feed" as const, replace: false, onReselect: () => {} };
  return (
    <div className={cn("grid h-[100dvh] min-h-0 bg-background text-foreground", GRID[nav])}>
      {nav === "sidebar" ? <Sidebar {...navProps} settings /> : null}
      {nav === "rail" ? <NavRail {...navProps} settings /> : null}
      <div className="min-h-0 min-w-0" data-surface="feed">
        <HomeFeedEntries source={source} ask={ask} />
      </div>
      {nav === "tabbar" ? <TabBar {...navProps} /> : null}
    </div>
  );
}

/** Home as it is by default: Settings → Show hidden features is off, so no ask box and no Agents pill. */
function HiddenFeaturesOff() {
  useLayoutEffect(() => {
    setShowHiddenFeatures(false);
    return () => setShowHiddenFeatures(true);
  }, []);
  return <Home source={FEED} ask={<HomeAskBox api={ENABLED} />} />;
}

/**
 * The feed with a view chosen before it first renders (the feed reads the saved choice when it mounts). The saved
 * choice goes back to the default once the feed has mounted, so the screens that run after this one are unaffected.
 */
function FeedIn({ mode, children }: { mode: FeedViewMode; children: ReactNode }) {
  useState(() => { saveFeedViewMode(mode); });
  useEffect(() => { saveFeedViewMode(DEFAULT_FEED_VIEW_MODE); }, []);
  return <>{children}</>;
}

function PendingHistoryNotice() {
  const [open, setOpen] = useState(false);
  const expiry = Date.UTC(2026, 10, 12);
  return <Home ask={<>
    <AskBox working={false} onSend={() => {}} onOpenMain={() => setOpen(true)} />
    <MainChat open={open} onOpenChange={setOpen} state={{ history: "loaded", lines: [], turn: null }}
      onSend={() => {}} onRetry={() => {}} onRetryHistory={() => {}} onReconnect={() => {}}
      notice={{ id: "f".repeat(64), expiresAt: expiry, firstAttemptAt: expiry }} />
  </>} />;
}

function CreateBotPreview({ cap = null }: { cap?: "flat3" | "table" | null }) {
  const [open, setOpen] = useState(true);
  const [created, setCreated] = useState<RosterBot | null>(null);
  const [api] = useState<BotRosterApi>(() => {
    const createdAt = new Date(FROZEN_NOW).toISOString();
    const main = { key: "main", name: BOTS_STRINGS.mainName, shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt } as const;
    const bots: RosterBot[] = cap === "flat3" ? [
      main,
      { ...main, key: "b".repeat(32), name: "Research", shape: "sprout", colour: "teal" },
      { ...main, key: "c".repeat(32), name: "Writing", shape: "bloom", colour: "pink" },
    ] : [main];
    const limits = { private: { max: cap === "table" ? 1 : 3, used: bots.length }, regular: { max: 0, used: 0 } };
    const roster: BotRoster = {
      bots, deleted: [], limits, capMode: cap ?? "flat3", canCreate: { private: !cap, regular: false },
    };
    return {
      list: async () => ({ ...roster }),
      create: async (input) => {
        const bot: RosterBot = { ...input, key: "a".repeat(32), createdAt, state: "active", environment: "private" };
        roster.bots = [...roster.bots, bot];
        const privateLimit = { max: limits.private.max, used: roster.bots.length };
        roster.limits = { ...limits, private: privateLimit };
        roster.canCreate = { ...roster.canCreate, private: privateLimit.used < privateLimit.max };
        return bot;
      },
      update: async () => { throw new Error("harness: updating is unavailable"); },
      remove: async () => { throw new Error("harness: removing is unavailable"); },
    };
  });
  const { roster, create } = useBots(api);
  return <>
    <Home source={FEED} ask={
      roster && <CreateBotDialog open={open} onOpenChange={setOpen} roster={roster} onCreate={create} onCreated={setCreated} />
    } />
    {created && <output hidden data-created-bot={JSON.stringify(created)} />}
  </>;
}

// Main's secret requests (lane B, F1): the card at each step and in each state, the Feed row, and the iPhone line.
// Synthetic names and links; nothing opens or is sent.
const SECRET_AT = { askedAt: new Date(FROZEN_NOW - 2 * 60_000).toISOString(), expiresAt: new Date(FROZEN_NOW + 22 * 3_600_000).toISOString() };
const SECRET_UNTIL = new Date(FROZEN_NOW + 6 * 3_600_000).toISOString();
const OPENAI = { kind: "secret" as const, name: "OPENAI_API_KEY", sites: ["api.openai.com"], service: "OpenAI", outside: false, undelivered: false, ...SECRET_AT };
const WHY = "To summarise your meeting notes with your own OpenAI account.";
const SECRETS_ASKED: SecretRequest[] = [
  { ...OPENAI, id: "fx-saved", state: "pending", why: WHY, approveUrl: "https://openkey.so/approve/fixture", outside: true },
  { ...OPENAI, id: "fx-unknown", state: "pending", name: "ACME_REPORTS_TOKEN", service: "", sites: ["api.acme.example", "eu.acme.example", "us.acme.example"], why: "To post the weekly report to Acme." },
];
const SECRETS_DONE: SecretRequest[] = [
  { ...OPENAI, id: "fx-approved", state: "approved", until: SECRET_UNTIL },
  { ...OPENAI, id: "fx-failed", state: "failed", name: "RESEND_API_KEY", service: "Resend", sites: ["api.resend.com"] },
  { ...OPENAI, id: "fx-ended", state: "ended", name: "GITHUB_TOKEN", service: "GitHub PAT", sites: ["api.github.com"], until: SECRET_AT.askedAt },
  { ...OPENAI, id: "fx-declined", state: "declined", name: "ELEVENLABS_API_KEY", service: "ElevenLabs", sites: ["api.elevenlabs.io"] },
  { ...OPENAI, id: "fx-expired", state: "expired", name: "FIREFLIES_API_KEY", service: "Fireflies", sites: ["api.fireflies.ai"] },
  { ...OPENAI, id: "fx-revoked", state: "revoked", name: "ANTHROPIC_API_KEY", service: "Anthropic", sites: ["api.anthropic.com"] },
];

function fixtureAsks(secrets: SecretRequest[], saved: string[] = []): Asks {
  const ok = async () => "ok" as const;
  return {
    support: "yes", enabled: true, stopped: false, pending: [], outcomes: [], secrets, saved: new Set(saved),
    owner: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001", webOn: false,
    noteWeb: () => {}, markSaved: () => {}, dismiss: () => {}, setEnabled: ok, stop: ok, decide: ok, refresh: () => {},
  };
}

function SecretChat({ secrets, saved, iphone = false }: { secrets: SecretRequest[]; saved?: string[]; iphone?: boolean }) {
  setSecretsAvailableForTests(!iphone);
  return <Home ask={<>
    <AskBox working={false} onSend={() => {}} onOpenMain={() => {}} />
    <MainChat open onOpenChange={() => {}} state={{ history: "loaded", lines: [], turn: null }}
      onSend={() => {}} onRetry={() => {}} onRetryHistory={() => {}} asks={fixtureAsks(secrets, saved)} />
  </>} />;
}

function SecretFeed() {
  setSecretsAvailableForTests(true);
  return <Home source={FEED} ask={<>
    <AskBox working={false} onSend={() => {}} onOpenMain={() => {}} />
    <div className="mb-6 flex flex-col gap-3" data-home-asks=""><SecretCards asks={fixtureAsks([SECRETS_ASKED[0]!, SECRETS_DONE[0]!])} onMessage={() => {}} /></div>
  </>} />;
}

const BASE = { group: "bots", layout: "pane", platform: "web", path: "/chat/feed", displayTitle: true } as const;

export const botsScreens: HarnessScreen[] = [
  { ...BASE, id: "bots-create", readyWhen: "[data-create-bot-dialog]", viewports: ["phone", "desktop-min", "desktop"],
    render: () => <CreateBotPreview /> },
  { ...BASE, id: "bots-create-at-cap", readyWhen: "[data-create-bot-dialog]", viewports: ["phone", "desktop-min", "desktop"],
    render: () => <CreateBotPreview cap="flat3" /> },
  { ...BASE, id: "bots-create-main-at-cap", readyWhen: "[data-create-bot-dialog]", viewports: ["phone", "desktop-min", "desktop"],
    render: () => <CreateBotPreview cap="table" /> },
  { ...BASE, id: "bots-history-expiry-pending", readyWhen: "[data-bots-ask]", render: () => <PendingHistoryNotice /> },
  {
    ...BASE, id: "bots-history-expiry", readyWhen: "[data-history-expiry-notice]",
    render: () => <Home ask={<>
      <AskBox working={false} onSend={() => {}} onOpenMain={() => {}} />
      <MainChat open onOpenChange={() => {}} state={{ history: "loaded", lines: [], turn: null }}
        onSend={() => {}} onRetry={() => {}} onRetryHistory={() => {}} onReconnect={() => {}}
        notice={{ id: "fixture", expiresAt: Date.UTC(2026, 10, 12), firstAttemptAt: Date.UTC(2026, 10, 12), deliveredAt: Date.UTC(2026, 10, 12), deleteAt: Date.UTC(2026, 11, 12) }} />
    </>} />,
  },
  { ...BASE, id: "bots-home", readyWhen: "[data-bots-ask]", render: () => <Home ask={<HomeAskBox api={ENABLED} />} /> },
  // Layout viewports only: at 200% text the compact cards truncate long agent names by design (CompactCard).
  { ...BASE, id: "bots-home-feed", readyWhen: 'section[aria-label="Pending"]', viewports: ["phone", "phone-402", "phone-land", "tablet", "tablet-land", "desktop-min", "desktop", "zoom200"],
    render: () => <Home source={FEED} ask={<HomeAskBox api={ENABLED} />} /> },
  { ...BASE, id: "home-hidden-features-off", readyWhen: 'section[aria-label="Pending"]', viewports: ["phone", "desktop-min"], render: () => <HiddenFeaturesOff /> },
  // The feed's three views, each with its choice saved before the feed renders (FeedIn).
  { ...BASE, id: "bots-home-feed-compact", readyWhen: 'section[aria-label="Pending"]', viewports: ["phone", "desktop"],
    render: () => <FeedIn mode="compact"><Home source={MANY} ask={<HomeAskBox api={ENABLED} />} /></FeedIn> },
  { ...BASE, id: "bots-home-feed-expanded", readyWhen: 'section[aria-label="Pending"]', viewports: ["phone", "desktop"],
    render: () => <FeedIn mode="expanded"><Home source={MANY} ask={<HomeAskBox api={ENABLED} />} /></FeedIn> },
  { ...BASE, id: "bots-home-feed-cards", readyWhen: 'section[aria-label="Pending"]', viewports: ["phone", "desktop"],
    render: () => <FeedIn mode="cards"><Home source={MANY} ask={<HomeAskBox api={ENABLED} />} /></FeedIn> },
  {
    ...BASE,
    id: "bots-main-reply",
    readyWhen: "[data-bots-main-chat]",
    render: () => (
      <Home
        ask={
          <>
            <AskBox working onSend={() => {}} onOpenMain={() => {}} />
            <MainChat open onOpenChange={() => {}} state={MID_REPLY} onSend={() => {}} onRetry={() => {}} onRetryHistory={() => {}} />
          </>
        }
      />
    ),
  },
  { ...BASE, id: "bots-secret-asked", readyWhen: "[data-secret-card]", viewports: ["phone", "desktop"],
    render: () => <SecretChat secrets={SECRETS_ASKED} saved={["fx-saved"]} /> },
  { ...BASE, id: "bots-secret-states", readyWhen: "[data-secret-card]", viewports: ["phone", "desktop"],
    render: () => <SecretChat secrets={SECRETS_DONE} /> },
  { ...BASE, id: "bots-secret-iphone", readyWhen: "[data-secret-iphone]", viewports: ["phone"],
    render: () => <SecretChat secrets={SECRETS_ASKED.slice(0, 1)} iphone /> },
  { ...BASE, id: "bots-secret-feed", readyWhen: "[data-secret-row]", viewports: ["phone", "desktop"], render: () => <SecretFeed /> },
];
