// The Bots view in the Chat slot (TC-3325), inside the app's navigation, with a fake bots service: Main's earlier
// messages with Markdown, a reply streaming in, a failed reply with Try again, and the history expiry notice.
import { useEffect, useState } from "react";

import { MAIN_BOT } from "@/bots/BotAvatar";
import type { BotMessage, MainEvent } from "@/bots/botsApi";
import { BotView, type ViewBot } from "@/bots/BotView";
import type { HistoryNotice } from "@/bots/historyNotice";
import { createBotChats, type BotChats } from "@/bots/useBotChat";
import { useSizeClass } from "@/lib/sizeClass";
import { cn } from "@/lib/utils";
import { NavRail } from "@/shell/NavRail";
import { navItems, navKindFor } from "@/shell/navItems";
import { Sidebar } from "@/shell/Sidebar";
import { TabBar } from "@/shell/TabBar";
import type { HarnessScreen } from "../screen";

const EARLIER: BotMessage[] = [
  { id: "1", role: "user", text: "What's on my plate this week?", at: "" },
  {
    id: "2",
    role: "bot",
    at: "",
    text: "Three things stand out:\n\n1. **Thursday's review** with the design team. The deck is half done.\n2. **The quarterly report**, due Friday.\n3. A reply to Dana about the venue.\n\nWant me to draft the reply to Dana first?",
  },
  { id: "3", role: "user", text: "Yes, keep it short.", at: "" },
  { id: "4", role: "bot", at: "", text: "Here's a draft:\n\n> Hi Dana, the hall works for us. Can we hold it for the 14th? Thanks!\n\nShall I send it?" },
];

type Reply = "stream" | "fail" | "none";

function fakeChats(reply: Reply): BotChats {
  return createBotChats(() => ({
    list: async () => EARLIER,
    send: (_text: string, onEvent: (event: MainEvent) => void) => {
      if (reply === "fail") {
        onEvent({ type: "error", code: "model_unavailable" });
        return Promise.resolve();
      }
      onEvent({ type: "status", state: "working" });
      onEvent({ type: "delta", text: "Sent. I'll let you know when Dana replies, and I've moved the" });
      // The reply never finishes, so the capture shows it mid-stream.
      return Promise.withResolvers<void>().promise;
    },
  }));
}

const GRID = {
  tabbar: "grid-cols-1 grid-rows-[minmax(0,1fr)_auto]",
  rail: "grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
  sidebar: "grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
} as const;

const MAIN: ViewBot = { key: "main", name: MAIN_BOT.name, private: true, face: MAIN_BOT };

function Screen({ reply, send, notice }: { reply: Reply; send?: string; notice?: HistoryNotice }) {
  const nav = navKindFor(useSizeClass());
  const navProps = { items: navItems(0), current: "chat" as const, replace: false, onReselect: () => {} };
  const [chats] = useState(() => fakeChats(reply));
  useEffect(() => {
    if (send) void chats.ensureHistory("main").then(() => chats.send("main", send));
  }, [chats, send]);
  return (
    <div className={cn("grid h-[100dvh] min-h-0 bg-background text-foreground", GRID[nav])}>
      {nav === "sidebar" ? <Sidebar {...navProps} settings /> : null}
      {nav === "rail" ? <NavRail {...navProps} settings /> : null}
      <div className="min-h-0 min-w-0" data-surface="chat">
        <BotView bot={MAIN} chats={chats} notice={notice} acknowledgeNotice={async (value) => value} onReconnect={() => {}} />
      </div>
      {nav === "tabbar" ? <TabBar {...navProps} /> : null}
    </div>
  );
}

const BASE = { group: "bot-view", layout: "pane", platform: "web", path: "/chat", viewports: ["phone", "tablet", "desktop"] } as const;
const EXPIRED = Date.UTC(2026, 10, 12);

export const botViewScreens: HarnessScreen[] = [
  { ...BASE, id: "bot-view-main", readyWhen: "[data-bot-reply]", render: () => <Screen reply="none" /> },
  { ...BASE, id: "bot-view-working", readyWhen: "[data-bot-working]", render: () => <Screen reply="stream" send="Send it, and move Thursday's review to 3pm." /> },
  { ...BASE, id: "bot-view-failed", readyWhen: '[role="alert"]', render: () => <Screen reply="fail" send="Send it." /> },
  {
    ...BASE,
    id: "bot-view-expiry",
    readyWhen: "[data-history-expiry-notice]",
    render: () => <Screen reply="none" notice={{ id: "fixture", expiresAt: EXPIRED, firstAttemptAt: EXPIRED, deliveredAt: EXPIRED, deleteAt: Date.UTC(2026, 11, 12) }} />,
  },
];
