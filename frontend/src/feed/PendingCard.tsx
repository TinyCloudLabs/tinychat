// Sam, 11-13: answered cards that are Waiting (the agent hasn't picked the answer up) or Done but not yet
// acknowledged leave the main flow, which keeps only what needs them. They gather in a "Pending" section after Updates
// and before History, in the stream's own row style (mock 24): the agent's mark, what he chose in bold with the post under
// it, and at the row's end whom it waits on. The section is not there while it is empty. A Done row offers Acknowledge,
// which goes through the page's undo pill like every other closing action. Tapping a row opens its card in place,
// where "Change answer" is.
import type { ReactNode } from "react";
import { Clock3Icon } from "lucide-react";

import { AgentMark } from "./AgentMark";
import { STREAM_HEADING_CLASS } from "./feedStream";
import { FOCUS_DIM_CLASS } from "./focusRow";

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
  /** The card's post, under that line. */
  post?: string;
  /** The card's answer is counting down or being written: its card is out of sight, so is the row. */
  waiting?: boolean;
  /** The card open in place, when the owner opened it from here. */
  open?: ReactNode;
  /** Another card is open (on a phone): this row dims. */
  dimmed?: boolean;
  onOpen: () => void;
  /** Done (or failed): the owner can acknowledge it now. */
  onAcknowledge?: () => void;
}

export function PendingCard({ items }: { items: readonly PendingItem[] }) {
  return <section aria-label="Pending">
    <h2 className={STREAM_HEADING_CLASS}><span>Pending</span><span className="tabular-nums">{items.length}</span></h2>
    <ul id="home-feed-pending" className="-mx-3 divide-y divide-border border-y border-border bg-card sm:-mx-6 lg:-mx-8">
      {items.map((item) => {
        const waiting = item.status.startsWith("Waiting");
        const lead = waiting && item.detail ? item.detail : item.title;
        const under = item.post || item.title;
        // Hidden (not removed) while its own answer counts: the open card inside keeps its place.
        return <li key={item.key} data-card-key={item.key} hidden={item.waiting} {...(item.dimmed ? { "data-dim": "" } : {})} className={`min-w-0 ${FOCUS_DIM_CLASS}`}>
          {item.open ? <div hidden={item.waiting} inert={item.waiting}>{item.open}</div> : <div className="flex items-start gap-3 px-4 pb-3 pt-3.5 min-[600px]:px-5 min-[600px]:pb-3.5 min-[600px]:pt-4">
            <button type="button" onClick={item.onOpen} aria-expanded={false} data-card-row className="relative flex min-h-11 min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="-my-[3px] shrink-0"><AgentMark agentKey={item.agentKey} name={item.author} small /></span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 break-words text-[15px] font-semibold leading-[22px] min-[600px]:text-base min-[600px]:leading-6">{lead}</span>
                {under && under !== lead && <span className="mt-0.5 line-clamp-2 break-words text-[15px] leading-[22px] text-muted-foreground min-[600px]:text-base min-[600px]:leading-6">{under}</span>}
              </span>
              {!item.onAcknowledge || waiting
                ? <span className="inline-flex shrink-0 items-center gap-1 text-meta text-muted-foreground">{waiting && <Clock3Icon aria-hidden className="size-3.5" />}{item.status}</span>
                : <span className="sr-only">{item.status}</span>}
            </button>
            {item.onAcknowledge && !waiting
              && <button type="button" onClick={item.onAcknowledge} className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-foreground px-3 text-[13px] font-semibold text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">Acknowledge</button>}
          </div>}
        </li>;
      })}
    </ul>
  </section>;
}
