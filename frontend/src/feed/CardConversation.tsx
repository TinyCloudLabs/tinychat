// The conversation at the foot of every card (feed lab, Sam's order of 11-12): your comments and the agent's replies,
// in time order, all left-aligned in Hunter's Mock 5 look. Under each of your comments: "Sent", then "Received"
// once the agent says so. One quiet control opens the comment box, and it stays open so you can
// go again. A comment never answers or moves the card.
import { useState } from "react";
import { CheckIcon, MessageSquareIcon } from "lucide-react";
import type { BoardRecord, SitrepOwnerData } from "@tinyboilerplate/core/feed/sitrep";
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
}

/** A plain card's conversation: your card messages, and the agent's replies in `payload.replies` ({ text, at }). */
export function plainConversation(entry: HomeFeedEntry): ConversationLine[] {
  const agent = entry.source.label;
  const mine = (entry.responses ?? []).flatMap((response) => response.kind === "message" && response.text ? [{
    key: `me:${response.responseId}`, mine: true, text: response.text, at: response.createdAt, who: agent,
    received: !!answerHandling(entry, response.responseId).acknowledgement,
  }] : []);
  const replies: unknown[] = Array.isArray(entry.state.card.payload?.replies) ? entry.state.card.payload.replies : [];
  const theirs = replies.flatMap((reply, index) => reply && typeof reply === "object" && "text" in reply && typeof reply.text === "string"
    ? [{ key: `agent:${index}`, mine: false, text: reply.text, at: "at" in reply && typeof reply.at === "string" ? reply.at : entry.state.card.createdAt, who: agent }]
    : []);
  return [...mine, ...theirs].sort((a, b) => a.at.localeCompare(b.at));
}

/** A typed card's conversation: the thread both ways, and words kept privately because no agent could take them. */
export function typedConversation(entry: HomeFeedEntry, record: BoardRecord, owner: SitrepOwnerData): ConversationLine[] {
  const thread = cardThread(entry, record, owner).map(({ message, header }) => message.side === "sam"
    ? { key: `me:${message.messageId}`, mine: true, text: message.text, at: message.at, who: messageRecipient(entry, record, message), received: !!(header && answerHandling(entry, header.responseId).acknowledgement) }
    : { key: `agent:${message.messageId}`, mine: false, text: message.text, at: message.at, who: message.from });
  const held = (owner.heldNotes ?? []).map((note) => ({ key: `held:${note.eventId}`, mine: true, text: note.text, at: note.at, who: note.intendedRecipient, held: true }));
  return [...thread, ...held].sort((a, b) => a.at.localeCompare(b.at));
}

function Tick({ done, label }: { done: boolean; label: string }) {
  return <span className={`inline-flex items-center gap-1 ${done ? "" : "text-muted-foreground"}`}>
    {done ? <CheckIcon aria-hidden className="size-3.5" strokeWidth={3} /> : <span aria-hidden className="size-3 rounded-full border-[1.5px] border-muted-foreground" />}
    {label}{!done && <span className="sr-only">, not yet</span>}
  </span>;
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
  async function send() {
    const value = text.trim();
    if (!value || saving) return;
    setSaving(true); setError(undefined);
    try { await onSend(value); setText(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Your comment wasn't sent. Try again."); }
    finally { setSaving(false); }
  }
  return <section aria-label="Comments" className="mt-4 space-y-3 border-t border-border pt-3 text-sm">
    {!!lines.length && <ol className="space-y-3">
      {lines.map((line) => <li key={line.key} data-mine={line.mine || undefined} className="max-w-[88%]">
        <p className={`inline-block whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[15px] leading-snug ${line.mine ? "bg-selected" : "border border-border bg-background"}`}>{line.text}</p>
        {line.mine
          ? <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">{line.held
            ? <span className="text-muted-foreground">Not sent · saved until {line.who} can get it</span>
            : <><Tick done label="Sent" /><Tick done={!!line.received} label="Received" /></>}</p>
          : <p className="mt-1 text-xs text-muted-foreground">{line.who} · <ShortTime at={line.at} /></p>}
      </li>)}
    </ol>}
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
