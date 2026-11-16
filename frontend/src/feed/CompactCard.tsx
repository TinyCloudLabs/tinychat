// The feed's row (Sam, 11-13 11:58Z, briefs/feed-lab/design/toprow): every card that isn't open is one row in a
// list, the agent's mark, the title (semibold when it needs you), the agent and a short description, and at the row's
// end its due date or how long ago it came, with its status. Rows sit together in one bordered list (HomeFeedEntries).
// Also the status mark the open card shares. Posts add a thumbnail.
import { AlarmClockIcon, CheckCheckIcon, CheckIcon, CircleAlertIcon, Clock3Icon, MessageCircleIcon, PlayIcon } from "lucide-react";

import { AgentMark, PlatformName, type Platform } from "./AgentMark";
import { ShortTime } from "./ShortTime";

/** A card's status as the compact card and the grid show it. `status` is cardStatus's word, or a post's progress. */
export function StatusMark({ status }: { status?: string }) {
  if (!status || status === "Information") return null;
  if (status === "Needs you") return <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-foreground px-2 text-[11px] font-semibold text-background">Needs you</span>;
  const quiet = "inline-flex shrink-0 items-center gap-1 text-meta text-muted-foreground [&_svg]:size-3.5";
  if (status.startsWith("Waiting on")) return <span className={quiet} title={status}><Clock3Icon aria-hidden />Waiting</span>;
  if (status === "Answered") return <span className={quiet}><CheckCheckIcon aria-hidden />Answered</span>;
  if (status === "Done") return <span className={quiet}><CheckIcon aria-hidden />Done</span>;
  if (status === "Snoozed") return <span className={quiet}><AlarmClockIcon aria-hidden />Snoozed</span>;
  if (status === "Failed") return <span className={`${quiet} text-destructive`}><CircleAlertIcon aria-hidden />Failed</span>;
  return <span className={quiet}>{status}</span>;
}

/** The agent's replies to your comments, beside the status (the design agent, after QA on 1f17120): the status is
 * about the decision, replies about the conversation, so one never hides the other. Bold with a dot while some reply
 * is newer than when you last opened the card. Inside a card's button, so the words are read as text, not a label. */
export interface Replies { count: number; unread: number; from: string }
export function ReplyCount({ replies }: { replies?: Replies }) {
  if (!replies?.count) return null;
  const fresh = replies.unread > 0;
  return <span className={`inline-flex shrink-0 items-center gap-1 text-meta tabular-nums ${fresh ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
    <MessageCircleIcon aria-hidden className="size-3.5" />
    <span aria-hidden>{replies.count}</span>
    {fresh && <span aria-hidden className="size-1.5 rounded-full bg-foreground" />}
    <span className="sr-only">{`${replies.count} ${replies.count === 1 ? "reply" : "replies"} from ${replies.from}${fresh ? `, ${replies.unread} new` : ""}`}</span>
  </span>;
}

/** A card's priority on the card itself (design round 7): only P0 and P1, which change what you do first; P2 to P5
 * show in the card's Details instead. Inside a card's button, so the words are read as text, not a label. */
export function PriorityMark({ priority }: { priority?: number }) {
  if (priority !== 0 && priority !== 1) return null;
  return <span className={`inline-flex h-4 shrink-0 items-center rounded px-1 text-[10px] font-semibold tabular-nums ${priority === 0 ? "bg-destructive text-destructive-foreground" : "bg-foreground/10 text-foreground"}`}>
    <span aria-hidden>P{priority}</span><span className="sr-only">{`Priority ${priority}`}</span>
  </span>;
}

const startOfDay = (at: number) => { const day = new Date(at); day.setHours(0, 0, 0, 0); return day; };
/** When a card is due, short and relative to `now` (design round 7): "Due in 20 min", "Due in 3 h" (under 12 hours),
 * "Due today 17:00", "Due tomorrow 9:00", "Due Friday" (within the week), else "Due 21 Nov"; "Overdue" once past.
 * Times, weekdays and dates in the reader's own locale. */
export function dueLabel(due: string, now: number = Date.now()): { text: string; overdue: boolean } {
  const at = Date.parse(due);
  if (Number.isNaN(at)) return { text: `Due ${due}`, overdue: false };
  const left = at - now;
  if (left < 0) return { text: "Overdue", overdue: true };
  if (left < 3_600_000) return { text: `Due in ${Math.max(1, Math.ceil(left / 60_000))} min`, overdue: false };
  if (left < 12 * 3_600_000) return { text: `Due in ${Math.round(left / 3_600_000)} h`, overdue: false };
  const date = new Date(at);
  const days = Math.round((startOfDay(at).getTime() - startOfDay(now).getTime()) / 86_400_000);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 0) return { text: `Due today ${time}`, overdue: false };
  if (days === 1) return { text: `Due tomorrow ${time}`, overdue: false };
  if (days < 7) return { text: `Due ${date.toLocaleDateString(undefined, { weekday: "long" })}`, overdue: false };
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return { text: `Due ${date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })}`, overdue: false };
}

/** dueLabel as a span: in the foreground, or the destructive colour once overdue; the full date one hover away. */
export function DueMark({ due, now, className = "" }: { due: string; now?: number; className?: string }) {
  const { text, overdue } = dueLabel(due, now);
  const at = new Date(due);
  return <span title={Number.isNaN(at.getTime()) ? undefined : `Due ${at.toLocaleString()}`} className={`font-medium ${overdue ? "text-destructive" : "text-foreground"} ${className}`}>{text}</span>;
}

export function CompactCard({ agentKey, author, platform, createdAt, priority, due, now, status, replies, title, description, thumb, onOpen, opensPage = false }: {
  agentKey: string; author: string; platform?: Platform; createdAt: string;
  /** The agent's priority, 0 (highest) to 5 (Sam, 23:30Z). Only P0 and P1 show, at the row's end (PriorityMark). */
  priority?: number;
  /** When the card is due (ISO), at the row's end (DueMark); `now` is the clock it is read against. */
  due?: string; now?: number;
  /** The agent's replies to your comments, at the row's end. */
  replies?: Replies;
  /** cardStatus's word (or a post's progress); "Needs you" and undefined show none (the view says it). */
  status?: string;
  title: string; description?: string;
  /** A post's page, as a 44px square at the row's end; `video` adds a play badge. */
  thumb?: { src: string; video: boolean };
  onOpen: () => void;
  /** A post opens its page; every other card opens in place. */
  opensPage?: boolean;
}) {
  const needsYou = status === "Needs you";
  const done = status === "Dropped" || status === "Acknowledged" || status === "Done" || status === "Closed";
  return <button type="button" onClick={onOpen} {...(opensPage ? { "aria-haspopup": "dialog" as const } : { "aria-expanded": false })}
    className="grid min-h-[60px] w-full min-w-0 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3.5 py-[9px] text-left text-card-foreground transition-colors duration-150 active:bg-muted/50 fine:hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none">
    <span className="row-span-2 self-center"><AgentMark agentKey={agentKey} name={author} small /></span>
    <span className={`line-clamp-2 break-words text-[15px] leading-5 tracking-[-0.005em] ${needsYou ? "font-semibold" : "font-medium"}`}>{done && <CheckIcon aria-hidden className="mr-1 inline size-3.5 align-[-2px] text-muted-foreground" />}{title}</span>
    <span className="col-start-3 row-span-2 row-start-1 flex flex-col items-end gap-1 self-center text-meta text-muted-foreground">
      {thumb ? <span className="relative size-11 overflow-hidden rounded-[10px] border border-border bg-muted">
        <img src={thumb.src} alt="" loading="lazy" className="size-full object-cover" />
        {thumb.video && <span aria-hidden className="absolute bottom-0.5 left-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white"><PlayIcon className="size-[9px]" /></span>}
      </span> : due ? <DueMark due={due} now={now} className="whitespace-nowrap" /> : <ShortTime relative at={createdAt} className="whitespace-nowrap tabular-nums" />}
      <span className="flex items-center gap-2 empty:hidden"><PriorityMark priority={priority} /><ReplyCount replies={replies} />{!needsYou && <StatusMark status={status} />}</span>
    </span>
    <span className="col-start-2 flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
      <span className="max-w-[60%] shrink-0 truncate font-medium text-foreground/80">{author}</span>
      {platform && <span className="flex min-w-0 shrink-0 items-center"><PlatformName platform={platform} logoOnly /></span>}
      {description && <span className="min-w-0 truncate before:mr-1.5 before:content-['·']">{description}</span>}
    </span>
  </button>;
}
