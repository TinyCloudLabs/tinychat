// Sam, 11-13: answered cards that are Waiting (the agent hasn't picked the answer up) or Done but not yet
// acknowledged leave the main flow, which keeps only what needs him. They fold into one small card at the end of the
// list, "Pending (N)", that opens in place. A Waiting row says what he answered; a Done row offers Acknowledge, which
// goes through the page's undo bar like every other closing action. Tapping a row opens its card in place, inside
// this card.
import type { ReactNode } from "react";
import { ChevronDownIcon, Clock3Icon } from "lucide-react";

import { AgentMark } from "./AgentMark";
import { StackedMarks } from "./AgentMarks";
import { ShortTime } from "./ShortTime";

export interface PendingItem {
  key: string;
  agentKey: string;
  author: string;
  title: string;
  /** "Done", "Failed" or "Waiting on <agent>": the card's status word. */
  status: string;
  at: string;
  /** What the owner answered ("You chose Go"), shown while it waits on the agent. */
  detail?: string;
  /** The card open in place, when the owner opened it from here. */
  open?: ReactNode;
  onOpen: () => void;
  /** Done (or failed): the owner can acknowledge it now. */
  onAcknowledge?: () => void;
}

export function PendingCard({ items, expanded, onToggle }: { items: readonly PendingItem[]; expanded: boolean; onToggle: () => void }) {
  const agents = [...new Map(items.map((item) => [item.agentKey, { key: item.agentKey, name: item.author }])).values()];
  return <section aria-label="Pending" className="rounded-2xl border border-dashed border-muted-foreground/45 bg-muted/45">
    <button type="button" aria-expanded={expanded} aria-controls="home-feed-pending" onClick={onToggle}
      className="flex min-h-14 w-full items-center gap-2.5 rounded-2xl px-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="text-[15px] font-semibold">Pending</span>
      <span className="min-w-0 flex-1 text-[13px] text-muted-foreground">{items.length} · answered, not closed yet</span>
      <StackedMarks agents={agents} size="sm" />
      <ChevronDownIcon aria-hidden className={`size-5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
    </button>
    {expanded && <ul id="home-feed-pending" className="divide-y divide-border border-t border-border">
      {items.map((item) => {
        const waiting = item.status.startsWith("Waiting");
        return <li key={item.key} data-card-key={item.key} className="min-w-0">
          {item.open ? <div className="p-2">{item.open}</div> : <div className="grid min-h-[52px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 px-3.5 py-2">
            <button type="button" onClick={item.onOpen} aria-expanded={false} className="grid min-w-0 grid-cols-[22px_minmax(0,1fr)] items-center gap-x-2.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="row-span-2"><AgentMark agentKey={item.agentKey} name={item.author} small /></span>
              <span className="truncate text-sm font-medium">{item.title}</span>
              <span className="truncate text-xs text-muted-foreground">{waiting && item.detail ? item.detail : item.status} · {item.author} · <ShortTime relative at={item.at} /></span>
            </button>
            {item.onAcknowledge && !waiting
              ? <button type="button" onClick={item.onAcknowledge} className="inline-flex min-h-9 items-center rounded-full bg-foreground px-3 text-[13px] font-semibold text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">Acknowledge</button>
              : <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Clock3Icon aria-hidden className="size-3.5" />Waiting</span>}
          </div>}
        </li>;
      })}
    </ul>}
  </section>;
}
