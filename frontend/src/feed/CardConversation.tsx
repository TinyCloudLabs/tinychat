// The conversation at the foot of every card: it reads like a chat. Your comments sit on the right in the feed's
// accent; the agent's replies sit on the left in grey, with its name and the time. Under your latest comment, one
// word moves on in place: "Sent", then "Received", then "Replied". "Received" means the agent confirmed it got the
// comment (an acknowledgement), not just that it was saved; a comment still unconfirmed after UNCONFIRMED_AFTER_MS
// says "Not confirmed" under itself, with "Send again". The agent can answer a particular comment: its reply carries
// that comment above it as a small outlined "ghost", and the comment gets an "N replies below" link; either opens the
// comment with all its replies on their own. A comment never answers or moves the card. Send and Cancel sit inside
// the box. A comment, and a "Send again", waits out the answers' undo window (usePendingSend, so a view change or
// pagehide sends it at once): it shows at once as your bubble with "Sending in 5s · Undo" under it, and Undo takes it
// back into the box.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpIcon } from "lucide-react";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import type { HomeFeedEntry } from "./feedStoreTypes";
import { ComposerField } from "./ComposerField";
import { StatefulSendButton } from "./StatefulSendButton";
import { ShortTime } from "./ShortTime";
import { COMMENT_COPY, UNDO_SECONDS, usePendingSend } from "./cardKit";
import { isOwnerAction } from "./ownerActions";

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
  /** The agent's lines: the `key` of your comment this one answers. */
  replyTo?: string;
  /** Yours: the delivery already reports it unconfirmed (typed receipts), whatever its age. */
  uncertain?: boolean;
  /** Yours: "Send again" cannot reach anyone (no routed recipient). */
  noResend?: boolean;
  /** Yours: delivery detail under the bubble (typed per-recipient receipts, a held route). */
  note?: ReactNode;
}

/**
 * A plain card's conversation: your card messages on every revision of the card, and the agent's `payload.replies`
 * ({ text, at?, replyTo? }), each timed by its `at` or else the first revision that carried it. Replies are
 * append-only, so reply i first appears in the earliest revision with more than i replies.
 */
export function plainConversation(entry: HomeFeedEntry, revisions: readonly HomeFeedEntry[] = []): ConversationLine[] {
  const agent = entry.source.label;
  const upTo = [...revisions, entry].filter((candidate) => candidate.state.card.revision <= entry.state.card.revision)
    .sort((a, b) => a.state.card.revision - b.state.card.revision);
  const lines: ConversationLine[] = [];
  const seen = new Set<string>();
  let count = 0;
  for (const revision of upTo) {
    for (const message of revision.responses ?? []) {
      if (message.kind !== "message" || !message.text || isOwnerAction(message) || seen.has(message.responseId)) continue;
      seen.add(message.responseId);
      lines.push({ key: `me:${message.responseId}`, id: message.responseId, mine: true, text: message.text, at: message.createdAt, who: agent,
        received: !!(revision.responseHandling?.[message.responseId]?.acknowledgement ?? entry.responseHandling?.[message.responseId]?.acknowledgement) });
    }
    const replies: unknown[] = Array.isArray(revision.state.card.payload?.replies) ? revision.state.card.payload.replies : [];
    for (let index = count; index < replies.length; index++) {
      const reply = replies[index];
      if (!reply || typeof reply !== "object" || !("text" in reply) || typeof reply.text !== "string") continue;
      lines.push({ key: `agent:${index}`, mine: false, text: reply.text, at: "at" in reply && typeof reply.at === "string" ? reply.at : revision.state.card.createdAt, who: agent,
        ...("replyTo" in reply && typeof reply.replyTo === "string" ? { replyTo: `me:${reply.replyTo}` } : {}) });
    }
    count = Math.max(count, replies.length);
  }
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

/** Where your latest comment stands, as one word that moves on in place. */
function commentStatus(line: ConversationLine, replies: number) {
  return replies ? "Replied" : line.received ? "Received" : "Sent";
}

/** How long a comment may go unconfirmed before it says so and offers "Send again". Agents acknowledge 8–56 s after
 * a response is stored, slow models up to 114 s; 120 s does not cry wolf on them. */
export const UNCONFIRMED_AFTER_MS = 120_000;

/** Your comments still waiting for the agent to confirm them: not received, not answered (a reply proves it got
 * there), not held, and not sent again since. A later comment of yours with the same words is the copy sent again,
 * and it carries the status from then on, so this holds across reloads without remembering anything. */
export function awaitingConfirmation(lines: readonly ConversationLine[]): ConversationLine[] {
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

/** A bubble's tail: on the last bubble of a run, in the bubble's own colour. */
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

export type ChatItem = { kind: "mine"; line: ConversationLine } | { kind: "theirs"; lines: ConversationLine[]; replyTo?: string };
/** The lines as the chat draws them: each of your comments alone, the agent's in runs (one run per comment it answers). */
export function chatItems(lines: readonly ConversationLine[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const line of lines) {
    const previous = items.at(-1);
    if (line.mine) items.push({ kind: "mine", line });
    else if (previous?.kind === "theirs" && previous.replyTo === line.replyTo) previous.lines.push(line);
    else items.push({ kind: "theirs", lines: [line], ...(line.replyTo ? { replyTo: line.replyTo } : {}) });
  }
  return items;
}

/** A comment on its way out, drawn after the thread until it shows in it: waiting out the undo window ("held"),
 * being saved, failed, or refused because the card changed. `resend` is the comment a "Send again" repeats. */
type Outgoing = { key: string; text: string; resend?: ConversationLine; state: "held" | "sending" | "error" | "refused" };

/**
 * The thread, then the comment control. `to` is who a comment goes to; with none (`reason` says why), there is no
 * control. `onSend` saves a comment and resolves true once saved, false when it was not. `onResend` sends an
 * unconfirmed comment again; without it (or without `to`) an unconfirmed comment only says so. Both run only after
 * the undo window, or at once if the card goes away, the view changes or the page is hidden; a `stale` card (a newer
 * issuance arrived meanwhile) refuses instead. `visible` false (a collapsed card) hides the thread but never a
 * comment on its way out or an open box.
 */
export function CardConversation({ lines, to, reason, disabled = false, stale = false, visible = true, onSend, onResend, composer }: {
  lines: readonly ConversationLine[];
  to?: string;
  reason?: string;
  disabled?: boolean;
  stale?: boolean;
  visible?: boolean;
  onSend: (text: string) => Promise<boolean>;
  onResend?: (line: ConversationLine) => Promise<boolean>;
  /** An update's comment box opens from "Comment" in the card's foot, not from a closed box here. */
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
  const settle = (key: string, state: Outgoing["state"]) => setOutbox((all) => all.map((out) => out.key === key ? { ...out, state } : out));
  const hold = usePendingSend({ stale, onRefused: () => {
    const item = held.current;
    held.current = undefined;
    if (!item) return;
    settle(item.key, "refused");
    // Its words go back in the box, so the owner can read the card again and send without retyping.
    if (item.resend) return;
    setText((now) => now.trim() ? `${item.text}\n${now}` : item.text);
    setOpen(true);
  } });
  async function deliver(item: Outgoing) {
    if (delivering.current.has(item.key)) return;
    delivering.current.add(item.key);
    settle(item.key, "sending");
    try {
      const saved = await (item.resend && onResend ? onResend(item.resend) : onSend(item.text));
      if (!saved) { settle(item.key, "error"); return; }
      const original = item.resend?.key;
      if (original) setResent((all) => new Set(all).add(original));
      // Saved, it is in `lines` now, with "Sent" under it.
      setOutbox((all) => all.filter((out) => out.key !== item.key));
    } catch { settle(item.key, "error"); }
    finally { delivering.current.delete(item.key); }
  }
  // Only the latest send can be undone: one still held when you send another goes now (start flushes it).
  function queue(item: Pick<Outgoing, "text" | "resend">) {
    made.current += 1;
    const next: Outgoing = { ...item, key: `out:${made.current}`, state: "held" };
    hold.start(next.text, () => {
      if (held.current?.key === next.key) held.current = undefined;
      void deliver(next);
    });
    held.current = next;
    setOutbox((all) => [...all, next]);
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
  const dismiss = (key: string) => setOutbox((all) => all.filter((out) => out.key !== key));
  const repliesTo = (key: string) => lines.filter((line) => line.replyTo === key);
  const original = (key?: string) => key ? lines.find((line) => line.key === key) : undefined;
  const opened = original(thread ?? undefined);
  const items = visible ? chatItems(lines) : [];
  // One status line, under your latest comment only, except that an unconfirmed comment says so under itself.
  const latestMine = [...lines].reverse().find((line) => line.mine && !line.held)?.key;
  const waiting = awaitingConfirmation(lines);
  const now = useConfirmationClock(waiting);
  const unconfirmed = new Set(waiting.filter((line) => line.uncertain || now - Date.parse(line.at) >= UNCONFIRMED_AFTER_MS).map((line) => line.key));
  const after = outbox.length ? "mine" : undefined;
  if (!items.length && !outbox.length && !open && (composer || !visible)) return null;
  return <section aria-label={COMMENT_COPY.list} className="mt-4 space-y-3 border-t border-border pt-3 text-sm">
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
          const word = unconfirmed.has(line.key) ? again ? "Sent again" : "Not confirmed"
            : line.key === latestMine ? commentStatus(line, count) : undefined;
          // A copy on its way out stands in for Send again until it is saved.
          const canResend = unconfirmed.has(line.key) && !line.noResend && !!onResend && !!to && !again && !outbox.some((out) => out.resend?.key === line.key);
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
            {line.note && <p className="mt-1 text-right text-xs text-muted-foreground">{line.note}</p>}
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
          <div className="flex items-stretch">
            <span aria-hidden className="-mb-[7px] ml-5 mr-1.5 mt-[13px] flex-1 rounded-tl-xl border-l-[1.5px] border-t-[1.5px] border-border" />
            <button type="button" onClick={() => setThread(quoted.key)} aria-label={`Reply to your comment: ${quoted.text}`}
              className="max-w-[70%] rounded-[14px] border border-border px-2.5 py-1 text-left text-[13px] leading-[17px] text-muted-foreground"><span className="line-clamp-2 break-words">{quoted.text}</span></button>
          </div>
          <div className="mt-1.5"><TheirRun lines={item.lines} /></div>
        </li>;
      })}
      {/* Your comments on their way out: the held one counts down with Undo; a failed one keeps its words, with Try again. */}
      {outbox.map((item, index) => {
        const gap = index > 0 || items.at(-1)?.kind === "mine" ? "mt-2" : items.length ? "mt-4" : "";
        return <li key={item.key} data-mine data-outgoing={item.state} className={`flex flex-col items-end ${gap}`}>
          <MineBubble text={item.text} tail={index === outbox.length - 1} />
          {item.state === "held" && <p className="mt-1 flex items-center justify-end gap-x-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="tabular-nums">{hold.pending ? `Sending in ${hold.pending.seconds}s` : "Sending…"}</span><span aria-hidden>·</span>
            <button type="button" onClick={undo} className="relative rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 after:absolute after:-inset-x-2 after:-inset-y-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:after:-inset-y-3">Undo</button>
          </p>}
          {item.state === "sending" && <p className="mt-1 text-xs text-muted-foreground">Sending…</p>}
          {item.state === "error" && <p className="mt-1 flex items-center justify-end gap-x-1.5 text-xs text-destructive">
            <span role="alert">Couldn't send</span><span aria-hidden>·</span>
            <button type="button" onClick={() => void deliver(item)} disabled={disabled} className="relative rounded-sm font-medium underline underline-offset-2 after:absolute after:-inset-x-2 after:-inset-y-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 fine:after:-inset-y-3">Retry</button>
          </p>}
          {item.state === "refused" && <p className="mt-1 flex items-center justify-end gap-x-1.5 text-xs text-muted-foreground">
            <span role="alert">Not sent · This card changed. Read it again, then send your comment.</span>
            <button type="button" onClick={() => dismiss(item.key)} className="relative rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 after:absolute after:-inset-x-2 after:-inset-y-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:after:-inset-y-3">OK</button>
          </p>}
        </li>;
      })}
    </ol>}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{hold.pending ? `Sending in ${UNDO_SECONDS} seconds. Undo is available until then.` : ""}</p>
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
      // Closed, the control has the shape of a composer.
      : !composer && visible && <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="flex min-h-11 w-full items-center gap-2 rounded-full border border-border pl-3.5 pr-1.5 text-left text-muted-foreground disabled:opacity-50">
        <span className="min-w-0 flex-1 truncate">Leave a comment for {to}</span>
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"><ArrowUpIcon className="size-4" /></span>
      </button>)}
    {!to && reason && visible && <p role="status" className="text-muted-foreground">{reason}</p>}
  </section>;
}
