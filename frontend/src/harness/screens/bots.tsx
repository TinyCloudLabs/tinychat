// Tiny bots, slice 1 (TC-2808): Home for an account with tiny bots on. The real Home feed (empty, as a
// new test account sees it) under the real navigation, with the ask box on top; then Main's chat over
// it, mid-reply. Synthetic content; nothing is sent anywhere. `bots-home-feed`: the same Home with cards from three
// agents, two of them answered (Sam's top bar, 11-13: the slider beside Filter and View, and Pending at the end).
import { useState, type ReactNode } from "react";

import { AskBox } from "@/bots/AskBox";
import type { BotsApi } from "@/bots/botsApi";
import { HomeAskBox } from "@/bots/HomeAskBox";
import { MainChat } from "@/bots/MainChat";
import type { MainChatState } from "@/bots/useMainChat";
import { HomeFeedEntries } from "@/feed/HomeFeedEntries";
import type { HomeFeedEntry, HomeFeedSource } from "@/feed/feedStoreTypes";
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

function card(sourceId: string, label: string, cardId: string, title: string, body: string, minutesAgo: number, answered?: "waiting" | "done"): HomeFeedEntry {
  const createdAt = new Date(FROZEN_NOW - minutesAgo * 60_000).toISOString();
  const database = (kind: string) => `xyz.tinycloud.tinychat/feed_${kind}_${sourceId}`;
  const response = answered ? { cardId, revision: 1, issuanceId: `${cardId}-1`, responseId: `${cardId}-answer`, sequence: 1, kind: "answer" as const, choiceId: "yes", createdAt } : null;
  const handling = (phase: "acknowledged" | "succeeded") => ({ cardId, revision: 1, issuanceId: `${cardId}-1`, responseId: `${cardId}-answer`, handlingId: `${cardId}-${phase}`, phase, createdAt });
  return {
    source: { sourceId, agentDid: `did:key:${sourceId}`, label, output: { spaceId: "harness", database: database("output") }, responses: { spaceId: "harness", database: database("responses") } },
    state: {
      card: { cardId, revision: 1, issuanceId: `${cardId}-1`, kind: "ask", needsResponse: true, title, body, urgency: 1, createdAt, choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "Not now" }] },
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

const ENABLED: BotsApi = {
  getBotsStatus: async () => ({ enabled: true }),
  listMainMessages: async () => [],
  sendToMain: () => new Promise(() => {}),
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

const BASE = { group: "bots", layout: "pane", platform: "web", path: "/chat/feed", displayTitle: true } as const;

export const botsScreens: HarnessScreen[] = [
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
];
