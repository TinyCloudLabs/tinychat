// Tiny bots, slice 1 (TC-2808): Home for an account with tiny bots on. The real Home feed (empty, as a
// new test account sees it) under the real navigation, with the ask box on top; then Main's chat over
// it, mid-reply. Synthetic content; nothing is sent anywhere.
import type { ReactNode } from "react";

import { AskBox } from "@/bots/AskBox";
import type { BotsApi } from "@/bots/botsApi";
import { HomeAskBox } from "@/bots/HomeAskBox";
import { MainChat } from "@/bots/MainChat";
import type { MainChatState } from "@/bots/useMainChat";
import { HomeFeedEntries } from "@/feed/HomeFeedEntries";
import type { HomeFeedSource } from "@/feed/feedStoreTypes";
import { useSizeClass } from "@/lib/sizeClass";
import { cn } from "@/lib/utils";
import { NavRail } from "@/shell/NavRail";
import { navItems, navKindFor } from "@/shell/navItems";
import { Sidebar } from "@/shell/Sidebar";
import { TabBar } from "@/shell/TabBar";
import type { HarnessScreen } from "../screen";

const EMPTY_FEED: HomeFeedSource = {
  load: async () => ({ entries: [], settings: { defaultSelector: "needs-action" } }),
  saveResponse: async () => { throw new Error("harness: read-only feed"); },
  markSeen: async () => {},
  snooze: async () => {},
  setDefaultSelector: async () => {},
  subscribe: () => () => {},
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

/** The Home site's navigation around the real Home feed. */
function Home({ ask }: { ask: ReactNode }) {
  const nav = navKindFor(useSizeClass());
  const navProps = { items: navItems(0, true), current: "feed" as const, replace: false, onReselect: () => {} };
  return (
    <div className={cn("grid h-[100dvh] min-h-0 bg-background text-foreground", GRID[nav])}>
      {nav === "sidebar" ? <Sidebar {...navProps} settings /> : null}
      {nav === "rail" ? <NavRail {...navProps} settings /> : null}
      <div className="min-h-0 min-w-0" data-surface="feed">
        <HomeFeedEntries source={EMPTY_FEED} homeSite ask={ask} />
      </div>
      {nav === "tabbar" ? <TabBar {...navProps} /> : null}
    </div>
  );
}

const BASE = { group: "bots", layout: "pane", platform: "web", path: "/chat/feed", displayTitle: true } as const;

export const botsScreens: HarnessScreen[] = [
  { ...BASE, id: "bots-home", readyWhen: "[data-bots-ask]", render: () => <Home ask={<HomeAskBox api={ENABLED} />} /> },
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
