import { AgentConversation, AgentList, agentThreads } from "./AgentConversation";
import type { HomeFeedEntry } from "./feedStoreTypes";

type ThreadOptions = Parameters<typeof agentThreads>[1];
interface AgentViewProps extends Omit<ThreadOptions, "key"> {
  entries: HomeFeedEntry[];
  page: string;
  agentKey: ThreadOptions["key"];
  lineageKey: (entry: HomeFeedEntry) => string;
  now: number;
  onPage: (page: string | null) => void;
  onOpenCard: (entry: HomeFeedEntry) => void;
}

export function AgentView({ entries, page, contextFor, author, agentKey, lineageKey, needsYou, unread, now, onPage, onOpenCard }: AgentViewProps) {
  const agents = agentThreads(entries.filter((entry) => !entries.some((other) => other !== entry && other.state.card.revision > entry.state.card.revision && lineageKey(other) === lineageKey(entry))), {
    contextFor, author, key: agentKey, needsYou, unread,
  });
  const agent = page !== "list" ? agents.find((thread) => thread.key === page) : undefined;
  return agent
    ? <AgentConversation agent={agent} onBack={() => onPage("list")} onOpenCard={onOpenCard} />
    : <AgentList agents={agents} now={now} onOpen={onPage} onBack={() => onPage(null)} />;
}
