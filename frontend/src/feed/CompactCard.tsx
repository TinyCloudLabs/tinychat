// The feed's row: every card that isn't open is one row in a flat list (HomeFeedEntries), the agent's mark and the
// card's post (its title when the agent wrote none), cut at four lines; at the row's end its due date, its task type
// and its status marks. Nothing else: the agent's name, the time and the options are in the open card. Also the status
// mark the open card shares. Posts add a thumbnail.
import { AlarmClockIcon, ArrowUpRightIcon, CheckCheckIcon, CheckIcon, CircleAlertIcon, Clock3Icon, MailIcon, MessageCircleIcon, PlayIcon, TriangleAlertIcon } from "lucide-react";

import { AgentMark, PlatformName, type Platform } from "./AgentMark";
import { cardTypeLabel, OUTBOUND_TYPES, type CardType } from "./feedData";

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

/**
 * What kind of task a card is (`payload.type`), at the top right of the row and of the open card, the same size on
 * both. A tag, not a control: a small square-cornered label like PriorityMark, never a pill. Colour is used sparingly
 * and never alone: the four types whose tap makes something leave the building (Spend, Publish, Send, Access) are
 * outlined in the primary colour with an outward arrow; Alert is in the warning colour with its triangle; the rest are
 * neutral.
 */
export function TypeLabel({ type }: { type?: CardType }) {
  if (!type) return null;
  const outbound = OUTBOUND_TYPES.has(type);
  const tone = outbound ? "border-primary/60 text-primary" : type === "alert" ? "border-transparent bg-warning/10 text-warning" : "border-transparent bg-muted text-muted-foreground";
  return <span data-card-type={type} className={`inline-flex h-5 shrink-0 items-center gap-0.5 whitespace-nowrap rounded border px-1.5 text-label font-semibold ${tone}`}>
    {outbound && <ArrowUpRightIcon aria-hidden className="size-3 shrink-0" />}
    {type === "alert" && <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />}
    {cardTypeLabel(type)}
  </span>;
}

/** A message another team sent over Courier: the mark that leads its card's name line, before its sender. */
export function CourierMark() {
  return <span data-courier className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-border px-1.5 text-label font-semibold text-foreground">
    <MailIcon aria-hidden className="size-3 shrink-0" />Courier
  </span>;
}

/** The agent's replies to your comments, beside the status (the design agent, after QA on 1f17120): the status is
 * about the decision, replies about the conversation, so one never hides the other. Bold with a dot while some reply
 * is newer than when you last opened the card. Inside a card's button, so the words are read as text, not a label. */
export interface Replies { count: number; unread: number; from: string }
function repliesWords(replies: Replies): string {
  return `${replies.count} ${replies.count === 1 ? "reply" : "replies"} from ${replies.from}${replies.unread > 0 ? `, ${replies.unread} new` : ""}`;
}
export function ReplyCount({ replies }: { replies?: Replies }) {
  if (!replies?.count) return null;
  const fresh = replies.unread > 0;
  return <span className={`inline-flex shrink-0 items-center gap-1 text-meta tabular-nums ${fresh ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
    <MessageCircleIcon aria-hidden className="size-3.5" />
    <span aria-hidden>{replies.count}</span>
    {fresh && <span aria-hidden className="size-1.5 rounded-full bg-foreground" />}
    <span className="sr-only">{repliesWords(replies)}</span>
  </span>;
}

/** A card's priority on the card itself (design round 7): only P0 and P1, which change what you do first; P2 to P5
 * show in the card's Details instead. Inside a card's button, so the words are read as text, not a label. */
export function PriorityMark({ priority }: { priority?: number }) {
  if (priority !== 0 && priority !== 1) return null;
  return <span className={`inline-flex h-4 shrink-0 items-center rounded px-1 text-[11px] font-semibold tabular-nums ${priority === 0 ? "bg-destructive text-destructive-foreground" : "bg-foreground/10 text-foreground"}`}>
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

export function CompactCard({ agentKey, author, platform, priority, due, now, status, replies, text, note, thumb, type, courier, onOpen, controls, opensPage = false, layout = "row" }: {
  agentKey: string; author: string; platform?: Platform;
  /** The card's task type, at the top of the row's end, or at the top right of a tile (TypeLabel). */
  type?: CardType;
  /**
   * A Courier message: the Courier mark and its sender make a line under its text, and `via`, the agent that
   * relayed it, is in its accessible name; the open card shows it.
   */
  courier?: { from?: string; via: string };
  /** The agent's priority, 0 (highest) to 5 (Sam, 23:30Z). Only P0 and P1 show, at the row's end (PriorityMark). */
  priority?: number;
  /** When the card is due (ISO), at the row's end (DueMark); `now` is the clock it is read against. */
  due?: string; now?: number;
  /** The agent's replies to your comments, at the row's end. */
  replies?: Replies;
  /** cardStatus's word (or a post's progress); "Needs you" and undefined show none (the view says it). */
  status?: string;
  /** The card's post, or its title when it has none. */
  text: string;
  /** Where the card stands when that is more than its post: what was chosen, when it comes back, what a ship moved. One line under the text. */
  note?: string;
  /** A post's page, as a 44px square at the row's end; `video` adds a play badge. */
  thumb?: { src: string; video: boolean };
  onOpen: () => void;
  /** The id of the open card this row opens into (`aria-controls`). */
  controls?: string;
  /** A post opens its page; every other card opens in place. */
  opensPage?: boolean;
  /** "row": the feed's row. "tile": a tile in the Cards view. */
  layout?: "row" | "tile";
}) {
  const needsYou = status === "Needs you";
  const done = status === "Dropped" || status === "Acknowledged" || status === "Done" || status === "Closed";
  const opens = opensPage ? { "aria-haspopup": "dialog" as const } : { "aria-expanded": false, ...(controls ? { "aria-controls": controls } : {}), "data-card-row": "" };
  const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none";
  const textClass = "line-clamp-4 break-words text-[15px] leading-[22px] [text-wrap:pretty] min-[600px]:text-base min-[600px]:leading-6";
  const doneMark = done && <CheckIcon aria-hidden className="mr-1 inline size-3.5 align-[-2px] text-muted-foreground" />;
  const hasMarks = priority === 0 || priority === 1 || !!replies?.count || (!needsYou && !!status && status !== "Information");
  const marks = hasMarks && <span className="flex items-center gap-2"><PriorityMark priority={priority} /><ReplyCount replies={replies} />{!needsYou && <StatusMark status={status} />}</span>;
  const noteLine = note && <span className="mt-1 block truncate text-[13px] leading-[18px] text-muted-foreground">{note}</span>;
  if (layout === "tile") {
    return <button type="button" onClick={onOpen} {...opens}
      className={`flex h-full min-h-[132px] w-full min-w-0 flex-col gap-1.5 p-3.5 text-left text-card-foreground transition-colors duration-150 active:bg-muted/50 fine:hover:bg-muted/30 ${ring}`}>
      <span className="flex min-w-0 items-center gap-2 text-[13px] leading-[18px] text-muted-foreground">
        <AgentMark agentKey={agentKey} name={author} small />
        {courier && <CourierMark />}
        <span className="min-w-0 truncate font-medium text-foreground/80">{courier?.from ?? author}</span>
        {courier?.from && <span className="sr-only">{`via ${courier.via}`}</span>}
        {platform && <span className="flex min-w-0 shrink-0 items-center"><PlatformName platform={platform} logoOnly /></span>}
        {/* The task type, at the top right of the tile, as on the row. */}
        {type && <span className="ml-auto flex shrink-0 items-center"><TypeLabel type={type} /></span>}
      </span>
      <span className={textClass}>{doneMark}{text}</span>
      {noteLine}
      {(marks || due) && <span className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1 text-meta text-muted-foreground">{marks}{due && <DueMark due={due} now={now} className="whitespace-nowrap" />}</span>}
    </button>;
  }
  const hasEnd = !!thumb || !!type || !!due || hasMarks;
  // The row prints no author, so its accessible name leads with it (a verified Courier message: its verified sender, as the sender line shows); the name replaces the button's own text, so it carries the rest of the row too.
  const name = [courier?.from ?? author, text, note, courier && `via ${courier.via}`, type && cardTypeLabel(type), !needsYou && status !== "Information" && status, (priority === 0 || priority === 1) && `Priority ${priority}`, replies?.count && repliesWords(replies), due && dueLabel(due, now).text]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "").join(". ");
  return <button type="button" onClick={onOpen} {...opens} aria-label={name}
    className="flex min-h-11 w-full min-w-0 items-start gap-3 px-4 pb-3 pt-3.5 text-left text-card-foreground transition-colors duration-150 active:bg-muted/50 fine:hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none min-[600px]:px-5 min-[600px]:pb-3.5 min-[600px]:pt-4">
    <span className="-my-[3px] shrink-0"><AgentMark agentKey={agentKey} name={author} small /></span>
    <span className="min-w-0 flex-1">
      <span className={textClass}>{doneMark}{text}</span>
      {noteLine}
      {courier && <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
        <CourierMark />
        <span className="min-w-0 truncate font-medium text-foreground/80">{courier.from ?? author}</span>
        {courier.from && <span className="sr-only">{`via ${courier.via}`}</span>}
      </span>}
    </span>
    {hasEnd && <span className="flex shrink-0 flex-col items-end gap-1 text-meta text-muted-foreground">
      <TypeLabel type={type} />
      {thumb ? <span className="relative size-11 overflow-hidden rounded-[10px] border border-border bg-muted">
        <img src={thumb.src} alt="" loading="lazy" className="size-full object-cover" />
        {thumb.video && <span aria-hidden className="absolute bottom-0.5 left-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white"><PlayIcon className="size-[9px]" /></span>}
      </span> : due && <DueMark due={due} now={now} className="whitespace-nowrap" />}
      {marks}
    </span>}
  </button>;
}
