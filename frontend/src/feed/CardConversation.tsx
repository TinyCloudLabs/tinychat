// The conversation at the foot of every card (feed lab, Sam 11-12): it reads like a chat. Your comments sit on the
// right in the feed's accent; the agent's replies sit on the left in grey, with its name and the time. Under each
// of your comments, one word moves on in place: "Sent", then "Received", then "Replied". The agent can answer a
// particular comment (iMessage's inline reply): its reply carries that comment above it as a small outlined
// "ghost", joined by a curved line, and the comment gets an "N Replies" link; either opens the comment with all its
// replies on their own. You only post plain comments; there is no reply-to for you (Sam, 22:31Z). A comment never
// answers or moves the card. One quiet control opens the comment box, and it stays open so you can go again.
import { useState } from "react";
import { ArrowUpIcon, MessageSquareIcon } from "lucide-react";
import type { BoardRecord, SitrepOwnerData } from "@tinyboilerplate/core/feed/sitrep";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import { answerHandling } from "./AnswerSteps";
import type { HomeFeedEntry } from "./feedStoreTypes";
import { cardThread, messageRecipient } from "./HomeCardThread";
import { ShortTime } from "./ShortTime";
export interface ConversationLine {
  key: string;
  /** Yours, or the agent's. */
  mine: boolean;
  text: string;
  at: string;
  /** Who wrote it (the agent's lines) or who it went to (yours). */
  who: string;
  /** Yours: whether the agent recorded that it received it. */
  received?: boolean;
  /** Yours, when no agent could take it: kept privately and not sent. */
  held?: boolean;
  /** The agent's lines: the `key` of your comment this one answers. In the real feed this is a new reply-to
   * reference on agent replies (the id of the comment answered); plain replies carry it as `replyTo`. */
  replyTo?: string;
}

/** A plain card's conversation: your card messages, and the agent's replies in `payload.replies` ({ text, at, replyTo? }). */
export function plainConversation(entry: HomeFeedEntry): ConversationLine[] {
  const agent = entry.source.label;
  const mine = (entry.responses ?? []).flatMap((response) => response.kind === "message" && response.text ? [{
    key: `me:${response.responseId}`, mine: true, text: response.text, at: response.createdAt, who: agent,
    received: !!answerHandling(entry, response.responseId).acknowledgement,
  }] : []);
  const replies: unknown[] = Array.isArray(entry.state.card.payload?.replies) ? entry.state.card.payload.replies : [];
  const theirs = replies.flatMap((reply, index) => reply && typeof reply === "object" && "text" in reply && typeof reply.text === "string"
    ? [{ key: `agent:${index}`, mine: false, text: reply.text, at: "at" in reply && typeof reply.at === "string" ? reply.at : entry.state.card.createdAt, who: agent,
      ...("replyTo" in reply && typeof reply.replyTo === "string" ? { replyTo: `me:${reply.replyTo}` } : {}) }]
    : []);
  return [...mine, ...theirs].sort((a, b) => a.at.localeCompare(b.at));
}

/** A typed card's conversation: the thread both ways, and words kept privately because no agent could take them. */
export function typedConversation(entry: HomeFeedEntry, record: BoardRecord, owner: SitrepOwnerData): ConversationLine[] {
  const thread = cardThread(entry, record, owner).map(({ message, header }) => message.side === "sam"
    ? { key: `me:${message.messageId}`, mine: true, text: message.text, at: message.at, who: messageRecipient(entry, record, message), received: !!(header && answerHandling(entry, header.responseId).acknowledgement) }
    : { key: `agent:${message.messageId}`, mine: false, text: message.text, at: message.at, who: message.from, ...(message.replyTo ? { replyTo: `me:${message.replyTo}` } : {}) });
  const held = (owner.heldNotes ?? []).map((note) => ({ key: `held:${note.eventId}`, mine: true, text: note.text, at: note.at, who: note.intendedRecipient, held: true }));
  return [...thread, ...held].sort((a, b) => a.at.localeCompare(b.at));
}

/** Where your comment stands, as one word that moves on in place. */
function commentStatus(line: ConversationLine, replies: number) {
  return replies ? "Replied" : line.received ? "Received" : "Sent";
}
const repliesLabel = (count: number) => count === 1 ? "1 Reply" : `${count} Replies`;

/** A bubble's tail (design agent, from iMessage): on the last bubble of a run, in the bubble's own colour. */
function Tail({ mine }: { mine: boolean }) {
  return <svg aria-hidden viewBox="0 0 8 13" className={mine ? "absolute -right-1.5 bottom-0 h-[13px] w-2 text-primary" : "absolute -left-1.5 bottom-0 h-[13px] w-2 -scale-x-100 text-muted"}><path d="M0 0C0 6.5 2.6 11 8 13H0Z" fill="currentColor" /></svg>;
}
/** Your comment: a right-aligned bubble in the accent. `tail` on the last of a run. */
function MineBubble({ line, tail = true }: { line: ConversationLine; tail?: boolean }) {
  return <p className={`relative ml-auto w-fit max-w-[80%] whitespace-pre-wrap break-words rounded-[18px] bg-primary px-3 py-2 text-[15px] leading-snug text-primary-foreground ${tail ? "rounded-br-[4px]" : ""}`}>{line.text}{tail && <Tail mine />}</p>;
}
/** The agent's line: a left-aligned grey bubble. `tail` on the last of a run. */
function TheirBubble({ line, tail = true }: { line: ConversationLine; tail?: boolean }) {
  return <p className={`relative w-fit max-w-[80%] whitespace-pre-wrap break-words rounded-[18px] bg-muted px-3 py-2 text-[15px] leading-snug text-foreground ${tail ? "rounded-bl-[4px]" : ""}`}>{line.text}{tail && <Tail mine={false} />}</p>;
}
/** A run of the agent's lines: its name and time once, then the bubbles close together, the last with a tail. */
function TheirRun({ lines }: { lines: readonly ConversationLine[] }) {
  return <div className="space-y-1">
    <p className="text-xs text-muted-foreground">{lines[0]!.who} · <ShortTime at={lines[0]!.at} /></p>
    {lines.map((line, index) => <TheirBubble key={line.key} line={line} tail={index === lines.length - 1} />)}
  </div>;
}

type Item = { kind: "mine"; line: ConversationLine } | { kind: "theirs"; lines: ConversationLine[]; replyTo?: string };
/** The lines as the chat draws them: each of your comments alone, the agent's in runs (one run per comment it answers). */
function chatItems(lines: readonly ConversationLine[]): Item[] {
  const items: Item[] = [];
  for (const line of lines) {
    const previous = items.at(-1);
    if (line.mine) items.push({ kind: "mine", line });
    else if (previous?.kind === "theirs" && previous.replyTo === line.replyTo) previous.lines.push(line);
    else items.push({ kind: "theirs", lines: [line], ...(line.replyTo ? { replyTo: line.replyTo } : {}) });
  }
  return items;
}

/**
 * The thread, then the comment control. `to` is who a comment goes to; with none (`reason` says why), there is no
 * control. `onSend` saves a comment and settles when it is saved; it throws when it is not.
 */
export function CardConversation({ lines, to, reason, disabled = false, onSend }: {
  lines: readonly ConversationLine[];
  to?: string;
  reason?: string;
  disabled?: boolean;
  onSend: (text: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // The comment whose replies are open on their own.
  const [thread, setThread] = useState<string | null>(null);
  async function send() {
    const value = text.trim();
    if (!value || saving) return;
    setSaving(true); setError(undefined);
    try { await onSend(value); setText(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Your comment wasn't sent. Try again."); }
    finally { setSaving(false); }
  }
  const repliesTo = (key: string) => lines.filter((line) => line.replyTo === key);
  const original = (key?: string) => key ? lines.find((line) => line.key === key) : undefined;
  const opened = original(thread ?? undefined);
  const items = chatItems(lines);
  return <section aria-label="Comments" className="mt-4 space-y-3 border-t border-border pt-3 text-sm">
    {!!items.length && <ol>
      {items.map((item, index) => {
        // Close together within a side, apart where the side changes.
        const gap = index === 0 ? "" : items[index - 1]!.kind === item.kind ? "mt-2" : "mt-4";
        if (item.kind === "mine") {
          const { line } = item;
          const count = repliesTo(line.key).length;
          return <li key={line.key} data-mine className={`flex flex-col items-end ${gap}`}>
            <MineBubble line={line} tail={items[index + 1]?.kind !== "mine"} />
            <p className="mt-1 flex flex-wrap items-center justify-end gap-x-1.5 text-xs text-muted-foreground">{line.held
              ? <span>Not sent · saved until {line.who} can get it</span>
              : <><span>{commentStatus(line, count)}</span>{!!count && <>·<button type="button" onClick={() => setThread(line.key)} className="min-h-6 font-medium text-primary underline-offset-2 hover:underline">{repliesLabel(count)}</button></>}</>}</p>
          </li>;
        }
        const quoted = original(item.replyTo);
        if (!quoted) return <li key={item.lines[0]!.key} className={gap}><TheirRun lines={item.lines} /></li>;
        return <li key={item.lines[0]!.key} className={gap}>
          {/* The comment answered, as a ghost on its own side, with a curve down to the replies; tapping it opens
              the comment with its replies. */}
          <div className="flex items-stretch">
            <span aria-hidden className="ml-4 mt-[0.9rem] flex-1 rounded-tl-xl border-l-2 border-t-2 border-border" />
            <button type="button" onClick={() => setThread(quoted.key)} aria-label={`Reply to your comment: ${quoted.text}`}
              className="ml-1 max-w-[70%] rounded-[14px] border border-primary/50 px-2.5 py-1 text-left text-[13px] leading-[17px] text-primary"><span className="line-clamp-2 break-words">{quoted.text}</span></button>
          </div>
          {/* One bracket down the left of every reply to that comment. */}
          <div className="ml-4 border-l-2 border-border pl-2 pt-1"><TheirRun lines={item.lines} /></div>
        </li>;
      })}
    </ol>}
    {/* A comment and all its replies, on their own. */}
    <ResponsiveSheet open={!!opened} onOpenChange={(next) => { if (!next) setThread(null); }} title="Replies">
      <ResponsiveSheetBody className="space-y-3 pb-6 text-sm">
        {opened && <><MineBubble line={opened} /><p className="text-right text-xs text-muted-foreground"><ShortTime at={opened.at} /></p>
          {!!repliesTo(opened.key).length && <TheirRun lines={repliesTo(opened.key)} />}</>}
      </ResponsiveSheetBody>
    </ResponsiveSheet>
    {to && (open
      ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea autoFocus rows={2} aria-label={`Leave a comment for ${to}`} placeholder={`Leave a comment for ${to}`} value={text} disabled={disabled || saving} onInput={(event) => setText(event.currentTarget.value)}
          className="block min-h-11 w-full resize-y rounded-[22px] border border-border bg-background px-4 py-2.5 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={disabled || saving || !text.trim()} className="min-h-11 rounded-lg bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50">{saving ? "Sending…" : "Send"}</button>
          <button type="button" onClick={() => { setOpen(false); setText(""); setError(undefined); }} className="min-h-11 rounded-lg border border-border px-4">Cancel</button>
        </div>
      </form>
      // Closed, the control has the shape of a composer (design agent).
      : <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="flex min-h-11 w-full items-center gap-2 rounded-full border border-border pl-3.5 pr-1.5 text-left text-muted-foreground disabled:opacity-50">
        <MessageSquareIcon aria-hidden className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">Leave a comment for {to}</span>
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"><ArrowUpIcon className="size-4" /></span>
      </button>)}
    {!to && reason && <p role="status" className="text-muted-foreground">{reason}</p>}
  </section>;
}
