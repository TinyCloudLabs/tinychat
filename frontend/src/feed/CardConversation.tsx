// The conversation at the foot of every card (feed lab, Sam 11-12): it reads like a chat. Your comments sit on the
// right in the feed's accent; the agent's replies sit on the left in grey, with its name and the time. Under each
// of your comments, one word moves on in place: "Sent", then "Received", then "Replied". "Received" means the agent
// confirmed it got the comment, not just that it was saved (Sam, 11-12); a comment still unconfirmed after
// UNCONFIRMED_AFTER_MS says "Not confirmed" under itself, whichever comment it is, with "Send again" (sitrep's
// Resend, gap analysis #5). The agent can answer a particular comment (iMessage's inline reply): its reply carries
// that comment above it as a small outlined "ghost", joined by a curved line, and the comment gets an "N Replies"
// link; either opens the comment with all its replies on their own. You only post plain comments; there is no
// reply-to for you (Sam, 22:31Z). A comment never answers or moves the card. One quiet control opens the comment
// box, and it stays open so you can go again. Send and Cancel sit inside the box (Sam, 23:35Z). A comment, and a
// "Send again", waits out the answers' undo window before it goes: it shows at once as your bubble with
// "Sending in 5s · Undo" under it, and Undo takes it back into the box.
import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon } from "lucide-react";
import { sendingLabel, UndoButton, useUndoWindow } from "./AnswerOptions";
import { ComposerField } from "./ComposerField";
import { StatefulSendButton } from "./StatefulSendButton";
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
  /** Yours: whether the agent confirmed it got it (an acknowledgement), not merely that it was saved. */
  received?: boolean;
  /** Yours, when sent: the id it was saved under (a plain card's `responseId`, a typed card's thread `messageId`), so
   * "Send again" can name the original. */
  id?: string;
  /** Yours, when no agent could take it: kept privately and not sent. */
  held?: boolean;
  /** The agent's lines: the `key` of your comment this one answers. In the real feed this is a new reply-to
   * reference on agent replies (the id of the comment answered); plain replies carry it as `replyTo`. */
  replyTo?: string;
}

/** A plain card's conversation: your card messages, and the agent's replies in `payload.replies` ({ text, at, replyTo? }).
 * Your card actions (snooze, drop, acknowledge: Sam, 23:40Z) are messages too, with private "feed.*" payloads; they
 * are not comments, so they never show here. */
export function plainConversation(entry: HomeFeedEntry): ConversationLine[] {
  const agent = entry.source.label;
  const mine = (entry.responses ?? []).flatMap((response) => response.kind === "message" && response.text && !response.payloadType?.startsWith("feed.") ? [{
    key: `me:${response.responseId}`, id: response.responseId, mine: true, text: response.text, at: response.createdAt, who: agent,
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
    ? { key: `me:${message.messageId}`, id: message.messageId, mine: true, text: message.text, at: message.at, who: messageRecipient(entry, record, message), received: !!(header && answerHandling(entry, header.responseId).acknowledgement) }
    : { key: `agent:${message.messageId}`, mine: false, text: message.text, at: message.at, who: message.from, ...(message.replyTo ? { replyTo: `me:${message.replyTo}` } : {}) });
  const held = (owner.heldNotes ?? []).map((note) => ({ key: `held:${note.eventId}`, mine: true, text: note.text, at: note.at, who: note.intendedRecipient, held: true }));
  return [...thread, ...held].sort((a, b) => a.at.localeCompare(b.at));
}

/** Where your latest comment stands, as one word that moves on in place. */
function commentStatus(line: ConversationLine, replies: number) {
  return replies ? "Replied" : line.received ? "Received" : "Sent";
}

/** How long a comment may go unconfirmed before it says so and offers "Send again". A delivery to a running agent
 * is confirmed within seconds; thirty is long enough not to cry wolf on a slow one. */
export const UNCONFIRMED_AFTER_MS = 30_000;

/** Your comments still waiting for the agent to confirm them: not received, not answered (a reply proves it got
 * there), not held, and not sent again since. A later comment of yours with the same words is the copy sent again,
 * and it carries the status from then on, so this holds across reloads without remembering anything. */
function awaitingConfirmation(lines: readonly ConversationLine[]) {
  return lines.filter((line, index) => line.mine && !line.held && !line.received
    && !lines.some((other) => other.replyTo === line.key)
    && !lines.slice(index + 1).some((later) => later.mine && !later.held && later.text === line.text));
}

/** The time, moved on just as the next waiting comment passes the threshold, so "Not confirmed" appears without a
 * reload. Nothing runs while no comment is waiting. */
function useConfirmationClock(waiting: readonly ConversationLine[]) {
  const [now, setNow] = useState(Date.now);
  const next = Math.min(Infinity, ...waiting.map((line) => Date.parse(line.at) + UNCONFIRMED_AFTER_MS).filter((due) => due > now));
  // `now` is a dependency too: a timer that fires a moment early re-arms instead of stopping.
  useEffect(() => {
    if (next === Infinity) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [next, now]);
  return now;
}
const belowLabel = (count: number) => count === 1 ? "1 reply below" : `${count} replies below`;

/** A bubble's tail (design agent, from iMessage): on the last bubble of a run, in the bubble's own colour. */
function Tail({ mine }: { mine: boolean }) {
  return <svg aria-hidden viewBox="0 0 8 13" className={mine ? "absolute -right-1.5 bottom-0 h-[13px] w-2 text-primary" : "absolute -left-1.5 bottom-0 h-[13px] w-2 -scale-x-100 text-muted"}><path d="M0 0C0 6.5 2.6 11 8 13H0Z" fill="currentColor" /></svg>;
}
/** Your comment: a right-aligned bubble in the accent. `tail` on the last of a run. */
function MineBubble({ text, tail = true }: { text: string; tail?: boolean }) {
  return <p className={`relative ml-auto w-fit max-w-[80%] whitespace-pre-wrap break-words rounded-[18px] bg-primary px-3 py-2 text-[15px] leading-snug text-primary-foreground ${tail ? "rounded-br-[4px]" : ""}`}>{text}{tail && <Tail mine />}</p>;
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

/** A comment on its way out, drawn after the thread until it shows in it: waiting out the undo window ("held"),
 * being saved, or failed. `resend` is the comment a "Send again" repeats. Only one is ever held. */
type Outgoing = { key: string; text: string; resend?: ConversationLine; state: "held" | "sending" | "error" };

/**
 * The thread, then the comment control. `to` is who a comment goes to; with none (`reason` says why), there is no
 * control. `onSend` saves a comment and settles when it is saved; it throws when it is not. `onResend` sends an
 * unconfirmed comment again, as a new comment with the same words; without it (or without `to`) an unconfirmed
 * comment only says so. Both run only after the undo window, or at once if the card goes away or the page is hidden.
 */
export function CardConversation({ lines, to, reason, disabled = false, onSend, onResend, composer }: {
  lines: readonly ConversationLine[];
  to?: string;
  reason?: string;
  disabled?: boolean;
  onSend: (text: string) => Promise<unknown>;
  onResend?: (line: ConversationLine) => Promise<unknown>;
  /** An update's comment box opens from "Comment" in the card's foot (Sam, 23:5xZ), not from a closed box here. */
  composer?: { open: boolean; onOpenChange: (open: boolean) => void };
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = composer ? composer.open : ownOpen;
  const setOpen = composer ? composer.onOpenChange : setOwnOpen;
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  // The comment whose replies are open on their own.
  const [thread, setThread] = useState<string | null>(null);
  // Comments on their way out. The refs answer at once, before state lands: which one the undo window holds, which
  // are being saved (so a double tap on Try again cannot save twice), and the next key.
  const [outbox, setOutbox] = useState<Outgoing[]>([]);
  const held = useRef<Outgoing | undefined>(undefined);
  const delivering = useRef(new Set<string>());
  const made = useRef(0);
  // Comments sent again. The original says "Sent again" until the copy shows in `lines`, which makes it no longer wait.
  const [resent, setResent] = useState<ReadonlySet<string>>(new Set());
  const hold = useUndoWindow(() => {
    const item = held.current;
    held.current = undefined;
    if (item) void deliver(item);
  });
  const settle = (key: string, state: Outgoing["state"]) => setOutbox((all) => all.map((out) => out.key === key ? { ...out, state } : out));
  async function deliver(item: Outgoing) {
    if (delivering.current.has(item.key)) return;
    delivering.current.add(item.key);
    settle(item.key, "sending");
    try {
      await (item.resend && onResend ? onResend(item.resend) : onSend(item.text));
      const original = item.resend?.key;
      if (original) setResent((all) => new Set(all).add(original));
      // Saved, it is in `lines` now, with "Sent" under it.
      setOutbox((all) => all.filter((out) => out.key !== item.key));
    } catch { settle(item.key, "error"); }
    finally { delivering.current.delete(item.key); }
  }
  // Only the latest send can be undone: one still held when you send another goes now.
  function queue(item: Pick<Outgoing, "text" | "resend">) {
    hold.flush();
    made.current += 1;
    const next: Outgoing = { ...item, key: `out:${made.current}`, state: "held" };
    held.current = next;
    setOutbox((all) => [...all, next]);
    hold.start();
  }
  function send() {
    const value = text.trim();
    // The same words already held are a double tap, not a second comment.
    if (!value || (held.current && !held.current.resend && held.current.text === value)) return;
    queue({ text: value });
    setText("");
  }
  function resend(line: ConversationLine) {
    if (!onResend || held.current?.resend?.key === line.key) return;
    queue({ text: line.text, resend: line });
  }
  // Undo drops the held comment and puts its words back in the box, ahead of anything typed since. A "Send again"
  // undone just goes; its original keeps its own Send again.
  function undo() {
    const item = held.current;
    if (!item) return;
    hold.undo();
    held.current = undefined;
    setOutbox((all) => all.filter((out) => out.key !== item.key));
    if (item.resend) return;
    setText((now) => now.trim() ? `${item.text}\n${now}` : item.text);
    if (input.current) input.current.focus();
    else setOpen(true);
  }
  const repliesTo = (key: string) => lines.filter((line) => line.replyTo === key);
  const original = (key?: string) => key ? lines.find((line) => line.key === key) : undefined;
  const opened = original(thread ?? undefined);
  const items = chatItems(lines);
  // One status line, under your latest comment only (the design agent, applied at Sam's word, 22:52Z), except
  // that an unconfirmed comment says so under itself wherever it is.
  const latestMine = [...lines].reverse().find((line) => line.mine && !line.held)?.key;
  const waiting = awaitingConfirmation(lines);
  const now = useConfirmationClock(waiting);
  const unconfirmed = new Set(waiting.filter((line) => now - Date.parse(line.at) >= UNCONFIRMED_AFTER_MS).map((line) => line.key));
  // What follows the last item of the thread: your comments on their way out, if any.
  const after = outbox.length ? "mine" : undefined;
  // An update with no comments yet and its box closed has nothing to show here.
  if (composer && !open && !items.length && !outbox.length) return null;
  return <section aria-label="Comments" className="mt-4 space-y-3 border-t border-border pt-3 text-sm">
    {!!(items.length || outbox.length) && <ol>
      {items.map((item, index) => {
        // Close together within a side, apart where the side changes.
        const gap = index === 0 ? "" : items[index - 1]!.kind === item.kind ? "mt-2" : "mt-4";
        if (item.kind === "mine") {
          const { line } = item;
          const count = repliesTo(line.key).length;
          // Replies that are not directly under this comment get a quiet pointer to them.
          const next = items[index + 1];
          const below = count - (next?.kind === "theirs" && next.replyTo === line.key ? next.lines.length : 0);
          const again = resent.has(line.key);
          // Held comments never wait or count as latest, so they have no word here.
          const word = unconfirmed.has(line.key) ? again ? "Sent again" : "Not confirmed"
            : line.key === latestMine ? commentStatus(line, count) : undefined;
          // A copy on its way out stands in for Send again until it is saved.
          const canResend = unconfirmed.has(line.key) && !!onResend && !!to && !again && !outbox.some((out) => out.resend?.key === line.key);
          return <li key={line.key} data-mine className={`flex flex-col items-end ${gap}`}>
            <MineBubble text={line.text} tail={(next?.kind ?? after) !== "mine"} />
            {line.held
              ? <p className="mt-1 text-xs text-muted-foreground">Not sent · saved until {line.who} can get it</p>
              : (word || below > 0) && <p className="mt-1 flex flex-wrap items-center justify-end gap-x-1.5 text-xs text-muted-foreground">
                {word && <span>{word}</span>}
                {/* Sending again cannot take back the first copy, which may still get through. */}
                {canResend && <><span aria-hidden>·</span><span>It may arrive twice if you send it again.</span></>}
                {word && below > 0 && <span aria-hidden>·</span>}
                {below > 0 && <button type="button" onClick={() => setThread(line.key)} className="min-h-6 font-medium text-foreground underline decoration-border underline-offset-2">{belowLabel(below)}</button>}
              </p>}
            {canResend && <button type="button" onClick={() => resend(line)} disabled={disabled}
              className="mt-1 inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-3.5 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 fine:min-h-10 fine:hover:bg-muted">Send again</button>}
          </li>;
        }
        // A reply right under the comment it answers needs no quote; one further down quotes it as a ghost.
        const quoted = original(item.replyTo);
        const previous = items[index - 1];
        const adjacent = previous?.kind === "mine" && previous.line.key === item.replyTo;
        if (!quoted || adjacent) return <li key={item.lines[0]!.key} className={gap}><TheirRun lines={item.lines} /></li>;
        return <li key={item.lines[0]!.key} className="mt-4">
          {/* The comment answered, as a ghost on its own side, joined by one curve to the reply below; tapping it
              opens the comment with its replies. */}
          <div className="flex items-stretch">
            <span aria-hidden className="-mb-[7px] ml-5 mr-1.5 mt-[13px] flex-1 rounded-tl-xl border-l-[1.5px] border-t-[1.5px] border-border" />
            <button type="button" onClick={() => setThread(quoted.key)} aria-label={`Reply to your comment: ${quoted.text}`}
              className="max-w-[70%] rounded-[14px] border border-border px-2.5 py-1 text-left text-[13px] leading-[17px] text-muted-foreground"><span className="line-clamp-2 break-words">{quoted.text}</span></button>
          </div>
          <div className="mt-1.5"><TheirRun lines={item.lines} /></div>
        </li>;
      })}
      {/* Your comments on their way out: the held one counts down with Undo (a screen reader hears the hold's own
          status instead of each second); a failed one keeps its words, with Try again. */}
      {outbox.map((item, index) => {
        const gap = index > 0 || items.at(-1)?.kind === "mine" ? "mt-2" : items.length ? "mt-4" : "";
        return <li key={item.key} data-mine data-outgoing={item.state} className={`flex flex-col items-end ${gap}`}>
          <MineBubble text={item.text} tail={index === outbox.length - 1} />
          {item.state === "held" && <p className="mt-1 flex items-center justify-end gap-x-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="tnum">{sendingLabel(hold.seconds)}</span><span aria-hidden>·</span><UndoButton onClick={undo} />
          </p>}
          {item.state === "sending" && <p className="mt-1 text-xs text-muted-foreground">Sending…</p>}
          {item.state === "error" && <p className="mt-1 flex items-center justify-end gap-x-1.5 text-xs text-destructive">
            <span role="alert">Couldn't send</span><span aria-hidden>·</span>
            <button type="button" onClick={() => void deliver(item)} disabled={disabled} className="relative rounded-sm font-medium underline underline-offset-2 after:absolute after:-inset-x-2 after:-inset-y-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 fine:after:-inset-y-3">Try again</button>
          </p>}
        </li>;
      })}
    </ol>}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{hold.status}</p>
    {/* A comment and all its replies, on their own. */}
    <ResponsiveSheet open={!!opened} onOpenChange={(next) => { if (!next) setThread(null); }} title="Replies">
      <ResponsiveSheetBody className="space-y-3 pb-6 text-sm">
        {opened && <><MineBubble text={opened.text} /><p className="text-right text-xs text-muted-foreground"><ShortTime at={opened.at} /></p>
          {!!repliesTo(opened.key).length && <TheirRun lines={repliesTo(opened.key)} />}</>}
      </ResponsiveSheetBody>
    </ResponsiveSheet>
    {to && (open
      ? <form onSubmit={(event) => { event.preventDefault(); send(); }}>
        <ComposerField inputRef={input} autoFocus label={`Leave a comment for ${to}`} placeholder={`Leave a comment for ${to}`} value={text} onValue={setText} disabled={disabled}
          onCancel={() => { setOpen(false); setText(""); }}
          send={<StatefulSendButton compact state="idle" onSend={send} disabled={disabled || !text.trim()} />} />
      </form>
      // Closed, the control has the shape of a composer (design agent).
      : !composer && <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="flex min-h-11 w-full items-center gap-2 rounded-full border border-border pl-3.5 pr-1.5 text-left text-muted-foreground disabled:opacity-50">
        <span className="min-w-0 flex-1 truncate">Leave a comment for {to}</span>
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"><ArrowUpIcon className="size-4" /></span>
      </button>)}
    {!to && reason && <p role="status" className="text-muted-foreground">{reason}</p>}
  </section>;
}
