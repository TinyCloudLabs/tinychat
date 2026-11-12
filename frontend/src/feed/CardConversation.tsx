// The conversation at the foot of every card (feed lab, Sam 11-12): it reads like a chat. Your comments sit on the
// right in the feed's accent; the agent's replies sit on the left in grey, with its name and the time. Under each
// of your comments, one word moves on in place: "Sent", then "Received", then "Replied". The agent can answer a
// particular comment (iMessage's inline reply): its reply carries that comment above it as a small outlined
// "ghost", joined by a curved line, and the comment gets an "N Replies" link; either opens the comment with all its
// replies on their own. You only post plain comments; there is no reply-to for you (Sam, 22:31Z). A comment never
// answers or moves the card. One quiet control opens the comment box, and it stays open so you can go again.
import { Fragment, useState } from "react";
import { MessageSquareIcon } from "lucide-react";
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

/** Your comment: a right-aligned bubble in the accent. */
function MineBubble({ line }: { line: ConversationLine }) {
  return <p className="ml-auto w-fit max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[15px] leading-snug text-primary-foreground">{line.text}</p>;
}
/** The agent's line: a left-aligned grey bubble, with its name and time above unless it continues a group. */
function TheirBubble({ line, named = true }: { line: ConversationLine; named?: boolean }) {
  return <div className="max-w-[80%]">
    {named && <p className="mb-1 text-xs text-muted-foreground">{line.who} · <ShortTime at={line.at} /></p>}
    <p className="w-fit whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-[15px] leading-snug text-foreground">{line.text}</p>
  </div>;
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
  return <section aria-label="Comments" className="mt-4 space-y-3 border-t border-border pt-3 text-sm">
    {!!lines.length && <ol className="space-y-3">
      {lines.map((line, index) => {
        if (line.mine) {
          const count = repliesTo(line.key).length;
          return <li key={line.key} data-mine className="flex flex-col items-end">
            <MineBubble line={line} />
            <p className="mt-1 flex flex-wrap items-center justify-end gap-x-1.5 text-xs text-muted-foreground">{line.held
              ? <span>Not sent · saved until {line.who} can get it</span>
              : <><span>{commentStatus(line, count)}</span>{!!count && <>·<button type="button" onClick={() => setThread(line.key)} className="min-h-6 font-medium text-primary underline-offset-2 hover:underline">{repliesLabel(count)}</button></>}</>}</p>
          </li>;
        }
        const quoted = original(line.replyTo);
        // Replies in a row to the same comment share one ghost and one bracket.
        const continues = !!line.replyTo && lines[index - 1]?.replyTo === line.replyTo;
        const last = lines[index + 1]?.replyTo !== line.replyTo || !line.replyTo;
        if (!quoted) return <li key={line.key}><TheirBubble line={line} /></li>;
        return <li key={line.key} className={continues ? "-mt-2" : ""}>
          {!continues && <Fragment>
            {/* The comment answered, as a ghost on its own side; tapping it opens the comment with its replies. */}
            <div className="flex items-stretch">
              {/* The curved line from the reply up to the ghost. */}
              <span aria-hidden className="ml-4 mt-[0.9rem] flex-1 rounded-tl-xl border-l-2 border-t-2 border-border" />
              <button type="button" onClick={() => setThread(quoted.key)} aria-label={`Reply to your comment: ${quoted.text}`}
                className="ml-1 max-w-[70%] rounded-2xl border border-primary/50 px-3 py-1.5 text-left text-xs leading-snug text-primary"><span className="line-clamp-2 break-words">{quoted.text}</span></button>
            </div>
          </Fragment>}
          {/* The bracket: one line down the left of every reply to that comment. */}
          <div className={`ml-4 border-l-2 border-border pl-2 ${continues ? "pt-2" : "pt-1"} ${last ? "pb-0.5" : ""}`}>
            <TheirBubble line={line} named={!continues} />
          </div>
        </li>;
      })}
    </ol>}
    {/* A comment and all its replies, on their own. */}
    <ResponsiveSheet open={!!opened} onOpenChange={(next) => { if (!next) setThread(null); }} title="Replies">
      <ResponsiveSheetBody className="space-y-3 pb-6 text-sm">
        {opened && <><MineBubble line={opened} /><p className="text-right text-xs text-muted-foreground"><ShortTime at={opened.at} /></p>
          {repliesTo(opened.key).map((reply) => <TheirBubble key={reply.key} line={reply} />)}</>}
      </ResponsiveSheetBody>
    </ResponsiveSheet>
    {to && (open
      ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea autoFocus rows={2} aria-label={`Leave a comment for ${to}`} placeholder={`Leave a comment for ${to}`} value={text} disabled={disabled || saving} onInput={(event) => setText(event.currentTarget.value)}
          className="block min-h-11 w-full resize-y rounded-xl border border-border bg-background p-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={disabled || saving || !text.trim()} className="min-h-11 rounded-lg bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50">{saving ? "Sending…" : "Send"}</button>
          <button type="button" onClick={() => { setOpen(false); setText(""); setError(undefined); }} className="min-h-11 rounded-lg border border-border px-4">Cancel</button>
        </div>
      </form>
      : <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-3 text-left text-muted-foreground disabled:opacity-50">
        <MessageSquareIcon aria-hidden className="size-4 shrink-0" />Leave a comment for {to}
      </button>)}
    {!to && reason && <p role="status" className="text-muted-foreground">{reason}</p>}
  </section>;
}
