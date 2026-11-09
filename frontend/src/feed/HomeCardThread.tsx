import { useEffect, useState, type ReactNode } from "react";
import { ownerThreadResponseKey, parseThreadKey, publisherThreadReceipts, recentThread, type BoardRecord, type SitrepOwnerData, type ThreadMessage } from "@tinyboilerplate/core/feed/sitrep";
import type { HomeFeedEntry } from "./feedStoreTypes";
import { cardTime, COMMENT_COPY, pillClass as buttonClass, quietClass } from "./cardKit";

interface Props {
  entry: HomeFeedEntry;
  record: BoardRecord;
  owner: SitrepOwnerData;
  busy: boolean;
  closed: boolean;
  now: number;
  /** The card is open: its comments show. */
  open: boolean;
  /** The composer is open. */
  composing: boolean;
  /** The composer's name: "Tell Helper agent something". */
  input: string;
  /** The line under it: "This doesn't answer the card. Only Helper agent sees this." */
  helper: string;
  onSend: (text: string) => Promise<boolean>;
  onResend: (text: string, resendOf: string) => Promise<boolean>;
  onClose: () => void;
}
function sameParent(entry: HomeFeedEntry, value: { cardId: string; revision: number; issuanceId: string }) { const card = entry.state.card; return card.cardId === value.cardId && card.revision === value.revision && card.issuanceId === value.issuanceId; }
function claimDeadline(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("state" in value) || value.state !== "claimed") return;
  const at = "at" in value ? value.at : "updatedAt" in value ? value.updatedAt : undefined;
  const parsed = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(parsed) ? parsed + 120_000 : undefined;
}

/**
 * One comment. `id` is what a reply's `replyTo` names; `mine` marks the owner's comments,
 * the only ones an agent comment can be a reply to.
 */
export interface ThreadItem { key: string; id: string; at: string; speaker: string; text: string; mine: boolean; replyTo?: string; status?: ReactNode }

/** How many comments a typed card has (the collapsed card shows the count). */
export function threadSize(entry: HomeFeedEntry, record: BoardRecord, owner: SitrepOwnerData): number {
  const linked = new Set([...Object.values(owner.threadResponses ?? {}), ...(owner.outboundNotes ?? []).map((note) => note.responseId)]);
  return owner.threads.filter((message) => message.kind === record.kind && message.id === record.id).length
    + (entry.responses?.filter((response) => response.kind === "message" && !linked.has(response.responseId)).length ?? 0)
    + (owner.heldNotes?.length ?? 0);
}

/**
 * Comments, as on the sitrep card threads: the owner's comments are top-level, and an agent
 * comment whose `replyTo` names a top-level owner comment sits one level under it. Nothing
 * nests deeper: a `replyTo` naming a reply, an agent comment, or an unknown id renders
 * top-level. Groups are oldest first; only the latest 2 top-level comments show until
 * "Show N earlier comments".
 */
export function commentTree(items: readonly ThreadItem[]): { item: ThreadItem; replies: ThreadItem[] }[] {
  const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
  const byId = new Map(sorted.map((item) => [item.id, item]));
  const parentOf = (item: ThreadItem) => {
    const parent = !item.mine && item.replyTo ? byId.get(item.replyTo) : undefined;
    return parent && parent.mine && !parent.replyTo ? parent : undefined;
  };
  const groups = sorted.filter((item) => !parentOf(item)).map((item) => ({ item, replies: [] as ThreadItem[] }));
  const byParent = new Map(groups.map((group) => [group.item.id, group]));
  for (const item of sorted) { const parent = parentOf(item); if (parent) byParent.get(parent.id)?.replies.push(item); }
  return groups;
}

function Comment({ item, now }: { item: ThreadItem; now: number }) {
  return <>
    <p className="text-[13px] leading-[18px]"><span className="font-semibold">{item.speaker}</span> <span className="tabular-nums text-muted-foreground">· <time dateTime={item.at}>{cardTime(item.at, now)}</time></span></p>
    <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.45]">{item.text}</p>
    {item.status && <p className="text-[13px] text-muted-foreground">{item.status}</p>}
  </>;
}

/** A card's comments, then the one-line composer when it is open. */
export function ThreadView({ items, now, open, composing, input, helper, busy, closed, onSend, onClose }: {
  items: readonly ThreadItem[]; now: number;
  /** The card is open: its comments show. */
  open: boolean;
  composing: boolean;
  /** The composer's name: "Tell Helper agent something". */
  input: string;
  /** The line under it: "This doesn't answer the card. Only Helper agent sees this." */
  helper: string;
  busy: boolean; closed: boolean;
  onSend: (text: string) => Promise<boolean>; onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  const groups = commentTree(items);
  const hidden = all ? 0 : Math.max(0, groups.length - 2);
  if ((!open || !groups.length) && !composing) return null;
  return <section aria-label={COMMENT_COPY.list} className="mt-3.5 space-y-2.5">
    {hidden > 0 && <button type="button" className={`${quietClass} -my-2`} onClick={() => setAll(true)}>{COMMENT_COPY.earlier(hidden)}</button>}
    {!!groups.length && <ol className="space-y-2.5">
      {groups.slice(hidden).map(({ item, replies }) => <li key={item.key} className="min-w-0">
        <Comment item={item} now={now} />
        {!!replies.length && <ol aria-label={`Replies to ${item.speaker}`} className="mt-2 space-y-2 border-l border-border pl-3">
          {replies.map((reply) => <li key={reply.key} className="min-w-0"><Comment item={reply} now={now} /></li>)}
        </ol>}
      </li>)}
    </ol>}
    {composing && <form onSubmit={(event) => { event.preventDefault(); if (text.trim()) void onSend(text.trim()).then((saved) => { if (saved) setText(""); }); }}>
      <div className="flex items-center gap-2">
        <input aria-label={input} value={text} autoFocus onInput={(event) => setText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }} disabled={closed || busy} placeholder={input}
          className="block h-11 min-w-0 flex-1 rounded-xl bg-background px-3 text-[15px] shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-60" />
        <button type="submit" className={buttonClass} disabled={closed || busy || !text.trim()}>Send</button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">{helper}</p>
        <button type="button" className={`${quietClass} shrink-0`} onClick={onClose}>Cancel</button>
      </div>
    </form>}
  </section>;
}

/**
 * A typed card's comments: the owner's thread messages (top-level) and the agent's, which sit
 * one level under the owner message their `replyTo` names.
 */
export function HomeCardThread({ entry, record, owner, busy, closed, now, open, composing, input, helper, onSend, onResend, onClose }: Props) {
  const [localClock, setLocalClock] = useState(now);
  const clock = Math.max(now, localClock);
  const agent = entry.source.label;
  const messages = recentThread(owner.threads.filter((message) => message.kind === record.kind && message.id === record.id));
  const legacyClaims = owner.deliveries.flatMap((delivery) => { const deadline = claimDeadline(delivery.originalReceipt); return deadline && deadline > clock ? [deadline] : []; });
  const liveClaims = messages.flatMap((message) => receiptsFor(message).reported.flatMap((receipt) => { const deadline = Date.parse(receipt.at) + 120_000; return receipt.state === "claimed" && deadline > clock ? [deadline] : []; }));
  const nextClaim = Math.min(...legacyClaims, ...liveClaims);
  const linked = new Set([...Object.values(owner.threadResponses ?? {}), ...(owner.outboundNotes ?? []).map((note) => note.responseId)]);
  const plainMessages = entry.responses?.filter((response) => response.kind === "message" && !linked.has(response.responseId)) ?? [];
  useEffect(() => {
    if (!Number.isFinite(nextClaim)) return;
    const timer = window.setTimeout(() => setLocalClock(Date.now()), Math.min(Math.max(0, nextClaim - Date.now() + 1), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [nextClaim, clock]);

  function receiptsFor(message: ThreadMessage) {
    const responseId = message.side === "sam" ? owner.threadResponses?.[ownerThreadResponseKey(message)] : undefined;
    const header = responseId ? entry.responses?.find((response) => response.responseId === responseId) : undefined;
    const handling = responseId ? entry.responseHandling?.[responseId] : undefined;
    const legacy = owner.deliveries.filter((delivery) => {
      if (!sameParent(entry, delivery.identity)) return false;
      if (responseId && delivery.responseId === responseId) return true;
      const key = parseThreadKey(delivery.eventSourceKey);
      return key?.side === message.side && key.messageId === message.messageId && key.kind === record.kind && key.id === record.id;
    });
    const reported = header ? publisherThreadReceipts(handling?.outcome?.detail ?? handling?.acknowledgement?.detail, header, message.messageId, entry.recipientRoute?.receiptRecipients ?? entry.recipientRoute?.recipients ?? []) : [];
    const waitingClaim = legacy.some((receipt) => (claimDeadline(receipt.originalReceipt) ?? 0) > clock) || reported.some((receipt) => receipt.state === "claimed" && Date.parse(receipt.at) + 120_000 > clock);
    const uncertain = legacy.some((receipt) => receipt.state === "unconfirmed") || reported.some((receipt) => receipt.state === "unconfirmed" || (receipt.state === "claimed" && Date.parse(receipt.at) + 120_000 <= clock));
    return { legacy, reported, handling, waitingClaim, uncertain };
  }
  function ownStatus(message: ThreadMessage): ReactNode {
    const { legacy, reported, handling, waitingClaim, uncertain } = receiptsFor(message);
    const route = entry.threadRoutes?.[ownerThreadResponseKey(message)];
    const routed = route?.kind === "publisher" || route?.kind === "recipients";
    const states = [
      ...legacy.map((receipt) => `${entry.recipientRoute?.recipients.find((recipient) => recipient.recipientKey === receipt.recipientKey)?.legacyName ?? receipt.recipientKey}: ${receipt.state === "unconfirmed" ? "Unconfirmed" : receipt.state}`),
      ...reported.map((receipt) => `${receipt.recipient}: ${receipt.state === "claimed" && Date.parse(receipt.at) + 120_000 <= clock ? "Unconfirmed" : receipt.state}`),
    ];
    return <>
      {waitingClaim ? <span>Sending…</span> : handling?.acknowledgement ? <span>{agent} got it</span> : null}
      {!!states.length && <span className="block">{states.join(" · ")}</span>}
      {uncertain && !waitingClaim && !closed && <span className="block">
        {route?.kind === "held" || !routed ? `Kept private, not sent: ${route?.kind === "held" ? route.unresolved.join(" / ") : "the first recipient"} isn't connected. ` : "It may not have arrived. Sending again makes a new message. "}
        <button type="button" disabled={busy || !routed} className={quietClass} onClick={() => void onResend(message.text, message.messageId)}>Resend message</button>
      </span>}
    </>;
  }

  const items: ThreadItem[] = [
    ...messages.map((message) => {
      const origin = owner.threadOrigins?.[ownerThreadResponseKey(message)];
      // Only output this card's registered agent published carries its name; archived
      // officer messages keep the display name they were written with.
      const speaker = message.side === "sam" ? "You" : origin?.kind === "agent-output" && origin.sourceId === entry.source.sourceId ? agent : message.from;
      return { key: `thread:${message.side}:${message.messageId}`, id: message.messageId, at: message.at, speaker: message.side === "sam" ? COMMENT_COPY.you : speaker, text: message.text, mine: message.side === "sam",
        ...(message.side === "officer" && message.replyTo ? { replyTo: message.replyTo } : {}), ...(message.side === "sam" ? { status: ownStatus(message) } : {}) };
    }),
    ...plainMessages.map((message) => ({ key: `message:${message.responseId}`, id: message.responseId, at: message.createdAt, speaker: COMMENT_COPY.you, text: message.text ?? "", mine: true,
      status: entry.responseHandling?.[message.responseId]?.acknowledgement ? <span>{agent} got it</span> : undefined })),
    ...(owner.heldNotes ?? []).map((note) => ({ key: `held:${note.eventId}`, id: note.eventId, at: note.at, speaker: COMMENT_COPY.you, text: note.text, mine: true,
      status: <span>Kept private, not sent: {note.intendedRecipient} isn't connected yet.</span> })),
  ];
  return <ThreadView items={items} now={clock} open={open} composing={composing} input={input} helper={helper} busy={busy} closed={closed} onSend={onSend} onClose={onClose} />;
}
