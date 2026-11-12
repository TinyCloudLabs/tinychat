// The Home feed with made-up cards under each design switch (src/feed/feedFlags.ts, TC-2600): the approved feed,
// one open card with rows, the agents menu, both together, and the comment control without its caption. The cards
// come from three agents, one with a reported platform, and one answer the agent has received.
import type { FeedResponse } from "@tinycloud/sdk-services/feed";
import { HomeFeedEntries } from "@/feed/HomeFeedEntries";
import { DEFAULT_FEED_FLAGS, FeedFlagsContext, type FeedFlags } from "@/feed/feedFlags";
import type { HomeFeedEntry, HomeFeedSource } from "@/feed/feedStoreTypes";
import { useSizeClass } from "@/lib/sizeClass";
import { cn } from "@/lib/utils";
import { NavRail } from "@/shell/NavRail";
import { navItems, navKindFor } from "@/shell/navItems";
import { Sidebar } from "@/shell/Sidebar";
import { TabBar } from "@/shell/TabBar";
import type { HarnessScreen } from "../screen";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function card(agent: { id: string; label: string; kind?: string }, cardId: string, minutes: number, card: Partial<HomeFeedEntry["state"]["card"]>): HomeFeedEntry {
  return {
    source: { sourceId: agent.id, agentDid: `did:key:${agent.id}`, label: agent.label,
      output: { spaceId: "harness", database: `xyz.tinycloud.tinychat/feed_output_${agent.id}` }, responses: { spaceId: "harness", database: `xyz.tinycloud.tinychat/feed_responses_${agent.id}` } },
    state: {
      card: { cardId, revision: 1, issuanceId: `${cardId}-1`, kind: "ask", needsResponse: true, title: "", body: "", urgency: 1, createdAt: minutesAgo(minutes),
        ...(agent.kind ? { payload: { agent: { kind: agent.kind } } } : {}), ...card },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: agent.id, cardId, revision: 1, issuanceId: `${cardId}-1` },
  };
}

const SPROCKET = { id: "sprocket", label: "Sprocket", kind: "claude-code" };
const NIMBUS = { id: "nimbus", label: "Nimbus", kind: "codex" };
const LEDGER = { id: "ledger", label: "Ledger" };

function sampleEntries(): HomeFeedEntry[] {
  const answered = card(NIMBUS, "venue", 95, { title: "Book the bigger room for Friday?", body: "Twelve people said yes. The small room seats ten.", choices: [{ id: "big", label: "Book the big room" }, { id: "small", label: "Keep the small room" }] });
  const response: FeedResponse = { responseId: "venue-answer", cardId: "venue", revision: 1, issuanceId: "venue-1", kind: "answer", choiceId: "big", createdAt: minutesAgo(40), sequence: 1 };
  answered.state.response = response;
  answered.responses = [response];
  answered.state.acknowledgement = { cardId: "venue", revision: 1, issuanceId: "venue-1", responseId: "venue-answer", handlingId: "venue-ack", phase: "acknowledged", createdAt: minutesAgo(39), detail: {} };
  return [
    card(SPROCKET, "ship", 12, { title: "Ship the card-link fix tonight?", body: "Checks passed and it was tried on the test copy. The restart takes about 30 seconds.", urgency: 3,
      choices: [{ id: "tonight", label: "Ship tonight (Recommended)" }, { id: "morning", label: "Wait until morning" }] }),
    card(NIMBUS, "flight", 30, { title: "Which flight should I hold for Thursday?", body: "Two flights fit your calendar. Holding one is free for 24 hours.", urgency: 2,
      choices: [{ id: "early", label: "07:10 direct" }, { id: "late", label: "09:40, one stop" }] }),
    card(LEDGER, "invoice", 50, { title: "Pay the October hosting invoice?", body: "$214.60, due on the 15th. Same as last month.", urgency: 1,
      choices: [{ id: "pay", label: "Pay it" }, { id: "hold", label: "Hold for review" }] }),
    answered,
    card(SPROCKET, "backup", 120, { kind: "progress", needsResponse: false, title: "Nightly backup finished", body: "1,204 new photos are stored in your TinyCloud space." }),
  ];
}

const SAMPLE: HomeFeedSource = {
  load: async () => ({ entries: sampleEntries(), settings: { defaultSelector: "both" } }),
  saveResponse: async (_entry, response) => ({ ...response, sequence: 2 }),
  sendMessage: async (_entry, message) => ({ ...message, sequence: 3 }),
  markSeen: async () => {},
  snooze: async () => {},
  setDefaultSelector: async () => {},
  subscribe: () => () => {},
};

const GRID = {
  tabbar: "grid-cols-1 grid-rows-[minmax(0,1fr)_auto]",
  rail: "grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
  sidebar: "grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]",
} as const;

/** The app's navigation around the real Home feed, under the given switches. */
function Feed({ flags }: { flags: Partial<FeedFlags> }) {
  const nav = navKindFor(useSizeClass());
  const navProps = { items: navItems(0), current: "feed" as const, replace: false, onReselect: () => {} };
  return (
    <FeedFlagsContext.Provider value={{ ...DEFAULT_FEED_FLAGS, ...flags }}>
      <div className={cn("grid h-[100dvh] min-h-0 bg-background text-foreground", GRID[nav])}>
        {nav === "sidebar" ? <Sidebar {...navProps} settings /> : null}
        {nav === "rail" ? <NavRail {...navProps} settings /> : null}
        <div className="min-h-0 min-w-0" data-surface="feed">
          <HomeFeedEntries source={SAMPLE} />
        </div>
        {nav === "tabbar" ? <TabBar {...navProps} /> : null}
      </div>
    </FeedFlagsContext.Provider>
  );
}

const BASE = { group: "feed", layout: "pane", platform: "web", path: "/chat/feed", displayTitle: true, readyWhen: 'article[aria-label="Ship the card-link fix tonight?"]' } as const;

export const feedScreens: HarnessScreen[] = [
  { ...BASE, id: "feed-approved", render: () => <Feed flags={{}} /> },
  { ...BASE, id: "feed-open-card", render: () => <Feed flags={{ layout: "open-card" }} /> },
  { ...BASE, id: "feed-agents-menu", render: () => <Feed flags={{ nav: "agents" }} /> },
  { ...BASE, id: "feed-open-card-agents-menu", render: () => <Feed flags={{ layout: "open-card", nav: "agents" }} /> },
  { ...BASE, id: "feed-undo-4", render: () => <Feed flags={{ undoSeconds: 4 }} /> },
  { ...BASE, id: "feed-captions-hidden", render: () => <Feed flags={{ captions: "hidden" }} /> },
];
