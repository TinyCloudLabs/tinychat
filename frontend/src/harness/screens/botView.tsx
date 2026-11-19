// The Bots view in the Chat slot (TC-3325), inside the app's navigation, with a fake bots service: Main's earlier
// messages with Markdown, a reply streaming in, a failed reply with Try again, and the history expiry notice.
import { useEffect, useState, type ReactNode } from "react";

import { MAIN_BOT } from "@/bots/BotAvatar";
import { createBotChatApi } from "@/bots/botChatApi";
import { botPath } from "@/bots/botPath";
import { createBotRosterApi } from "@/bots/botRosterApi";
import { createBotsApi, type BotActivity, type BotMessage, type MainEvent } from "@/bots/botsApi";
import { saveChatView } from "@/bots/chatViewSetting";
import { ChatSlot } from "@/bots/ChatSlot";
import { BotView, type ViewBot } from "@/bots/BotView";
import type { BotManagement } from "@/bots/BotManage";
import type { HistoryNotice } from "@/bots/historyNotice";
import { createBotChats, type BotChats } from "@/bots/useBotChat";
import { useSizeClass } from "@/lib/sizeClass";
import { cn } from "@/lib/utils";
import { NavRail } from "@/shell/NavRail";
import { navItems, navKindFor } from "@/shell/navItems";
import { Sidebar } from "@/shell/Sidebar";
import { TabBar } from "@/shell/TabBar";
import { HARNESS_DID, harnessTcw } from "../stubs";
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

/** The same conversation with times, so the activity lines fall between its messages. */
const TIMED: BotMessage[] = EARLIER.map((message, index) => ({ ...message, at: `2026-11-18T09:0${index * 2}:00.000Z` }));
const ACTIVITY: BotActivity[] = [
  { id: "a".repeat(32), verb: "ran_commands", count: 3, at: "2026-11-18T09:01:00.000Z" },
  { id: "b".repeat(32), verb: "changed_files", count: 1, at: "2026-11-18T09:01:30.000Z" },
  { id: "c".repeat(32), verb: "ran_commands", count: 1, at: "2026-11-18T09:05:00.000Z" },
  { id: "d".repeat(32), verb: "changed_files", count: 2, at: "2026-11-18T09:05:30.000Z" },
];

type Reply = "stream" | "fail" | "none";

function fakeChats(reply: Reply, timed = false): BotChats {
  return createBotChats(() => ({
    list: async () => (timed ? TIMED : EARLIER),
    listConversation: async () => ({ messages: timed ? TIMED : EARLIER, activity: timed ? ACTIVITY : [] }),
    send: (_text: string, onEvent: (event: MainEvent) => void) => {
      if (reply === "fail") {
        onEvent({ type: "error", code: "model_unavailable" });
        return Promise.resolve();
      }
      onEvent({ type: "status", state: "working" });
      onEvent({ type: "delta", text: "Sent. I'll let you know when Dana replies, and I've moved the" });
      // The reply never finishes, so the capture shows it mid-stream.
      return new Promise<void>(() => {});
    },
  }));
}

const GRID = {
  tabbar: "grid-cols-1 grid-rows-[minmax(0,1fr)_auto]",
  rail: "grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
  sidebar: "grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
} as const;

const MAIN: ViewBot = { key: "main", name: MAIN_BOT.name, private: true, face: MAIN_BOT };
const RESEARCH: ViewBot = { key: "0123456789abcdef0123456789abcdef", name: "Research", private: true, face: { name: "Research", shape: "sprout", colour: "green" } };
/** Edit and Delete bot do nothing here: the harness has no roster. */
const MANAGE: BotManagement = { shape: "sprout", colour: "green", takenNames: ["Main"], update: async () => {}, remove: async () => {} };

function Screen({ reply, send, notice, timed, panel, manage }: { reply: Reply; send?: string; notice?: HistoryNotice; timed?: boolean; panel?: boolean; manage?: boolean }) {
  const [chats] = useState(() => fakeChats(reply, timed));
  useEffect(() => {
    if (send) void chats.ensureHistory("main").then(() => chats.send("main", send));
  }, [chats, send]);
  // The panel opens from the pill, as an owner opens it.
  useEffect(() => {
    if (panel) document.querySelector<HTMLButtonElement>("[data-bot-view] h1 button")?.click();
  }, [panel]);
  return (
    <Frame>
      <BotView bot={manage ? RESEARCH : MAIN} chats={chats} notice={notice} acknowledgeNotice={async (value) => value} onReconnect={() => {}} manage={manage ? MANAGE : undefined} />
    </Frame>
  );
}

/** The Chat slot over real HTTP: the real clients read the list, the roster and the reply stream from whatever answers at this origin. */
function WireScreen() {
  const [clients] = useState(() => {
    const options = { baseUrl: window.location.origin, getToken: () => "harness" };
    saveChatView(HARNESS_DID, "bots");
    return { api: createBotsApi(options), chatApi: createBotChatApi(options), rosterApi: createBotRosterApi(options) };
  });
  return (
    <Frame>
      <ChatSlot account={HARNESS_DID} tcw={harnessTcw} active classic={<div />} history={null} {...clients} />
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const nav = navKindFor(useSizeClass());
  const navProps = { items: navItems(0), current: "chat" as const, replace: false, onReselect: () => {} };
  return (
    <div className={cn("grid h-[100dvh] min-h-0 bg-background text-foreground", GRID[nav])}>
      {nav === "sidebar" ? <Sidebar {...navProps} settings /> : null}
      {nav === "rail" ? <NavRail {...navProps} settings /> : null}
      <div className="min-h-0 min-w-0" data-surface="chat">{children}</div>
      {nav === "tabbar" ? <TabBar {...navProps} /> : null}
    </div>
  );
}

const VIEWPORTS = ["phone", "tablet", "desktop"];
const BASE = { group: "bot-view", layout: "pane", platform: "web", path: "/chat", viewports: VIEWPORTS } as const;
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
  { ...BASE, id: "bot-view-activity", readyWhen: "[data-bot-activity]", render: () => <Screen reply="none" timed /> },
  { ...BASE, id: "bot-view-panel", readyWhen: "[data-bot-panel]", render: () => <Screen reply="none" timed panel /> },
  { ...BASE, id: "bot-view-panel-manage", readyWhen: "[data-bot-panel]", render: () => <Screen reply="none" timed panel manage /> },
  // Driven by hand against a stand-in service (the screenshot run has none): the Chat slot over real HTTP, on Research's address.
  { ...BASE, id: "bot-view-wire", path: botPath("0123456789abcdef0123456789abcdef"), interactive: true, render: () => <WireScreen /> },
];
