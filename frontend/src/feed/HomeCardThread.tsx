import { useEffect, useState, type ReactNode } from "react";
import { ownerThreadResponseKey, parseThreadKey, publisherThreadReceipts, recentThread, type BoardRecord, type SitrepOwnerData, type ThreadMessage } from "@tinyboilerplate/core/feed/sitrep";
import { AnswerSteps } from "./AnswerSteps";
import { cardAuthor, type ReplyRoute } from "./CardReply";
import type { HomeFeedEntry } from "./feedStoreTypes";

interface Props {
  entry: HomeFeedEntry;
  record: BoardRecord;
  owner: SitrepOwnerData;
  busy: boolean;
  closed: boolean;
  now: number;
  route: ReplyRoute;
  /** The reply box, or null while the card's own answer box is the place to write. */
  reply: ReactNode;
  onResend: (text: string, resendOf: string) => Promise<boolean>;
}
const buttonClass = "min-h-10 rounded-lg border border-border px-3 text-sm disabled:opacity-50";
function sameParent(entry: HomeFeedEntry, value: { cardId: string; revision: number; issuanceId: string }) { const card = entry.state.card; return card.cardId === value.cardId && card.revision === value.revision && card.issuanceId === value.issuanceId; }
function claimDeadline(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("state" in value) || value.state !== "claimed") return;
  const at = "at" in value ? value.at : "updatedAt" in value ? value.updatedAt : undefined;
  const parsed = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(parsed) ? parsed + 120_000 : undefined;
}
/** A card's messages, oldest first, and the response each of the person's own messages was saved as. */
export function cardThread(entry: HomeFeedEntry, record: BoardRecord, owner: SitrepOwnerData) {
  return recentThread(owner.threads.filter((message) => message.kind === record.kind && message.id === record.id)).map((message) => {
    const responseId = message.side === "sam" ? owner.threadResponses?.[ownerThreadResponseKey(message)] : undefined;
    return { message, header: responseId ? entry.responses?.find((response) => response.responseId === responseId) : undefined };
  });
}
/** Who a message went to: the agents it was addressed to, or else the card's author. */
export function messageRecipient(entry: HomeFeedEntry, record: BoardRecord, message: ThreadMessage): string {
  const route = entry.threadRoutes?.[ownerThreadResponseKey(message)];
  if (route?.kind === "recipients") return route.delivery.targets.map((target) => entry.recipientRoute?.recipients.find((recipient) => recipient.recipientKey === target.recipientKey)?.legacyName ?? target.agentId).join(" / ");
  return cardAuthor(entry, record).name;
}

/**
 * The conversation under a typed card: the messages both ways, open once there is one, each of the person's own
 * with its steps, then the one reply box. How each message was routed and receipted is kept under Details.
 */
export function HomeCardThread({ entry, record, owner, busy, closed, now, route, reply, onResend }: Props) {
  const [open, setOpen] = useState(true);
  const [localClock, setLocalClock] = useState(now);
  const clock = Math.max(now, localClock);
  const thread = cardThread(entry, record, owner);
  const messages = thread.map(({ message }) => message);
  const legacyClaims = owner.deliveries.flatMap((delivery) => { const deadline = claimDeadline(delivery.originalReceipt); return deadline && deadline > clock ? [deadline] : []; });
  const liveClaims = messages.flatMap((message) => receiptsFor(message).reported.flatMap((receipt) => { const deadline = Date.parse(receipt.at) + 120_000; return receipt.state === "claimed" && deadline > clock ? [deadline] : []; }));
  const nextClaim = Math.min(...legacyClaims, ...liveClaims);
  const linked = new Set([...Object.values(owner.threadResponses ?? {}), ...(owner.outboundNotes ?? []).map((note) => note.responseId)]);
  const plainMessages = entry.responses?.filter((response) => response.kind === "message" && !linked.has(response.responseId)) ?? [];
  const heldNotes = owner.heldNotes ?? [];
  useEffect(() => {
    if (!open || !Number.isFinite(nextClaim)) return;
    const timer = window.setTimeout(() => setLocalClock(Date.now()), Math.min(Math.max(0, nextClaim - Date.now() + 1), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [open, nextClaim, clock]);

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
    return { header, legacy, reported, handling, waitingClaim, uncertain };
  }
  const messageKey = (message: ThreadMessage) => JSON.stringify([message.kind, message.id, message.side, message.messageId]);
  const author = cardAuthor(entry, record).name;
  const wiring = messages.length > 0 || plainMessages.length > 0;

  return <section aria-label="Card thread" className="space-y-3">
    {!!messages.length && <div className="space-y-3 rounded-xl border border-border p-3">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-9 w-full items-center justify-between gap-2 text-left font-medium">
        <span className="min-w-0 break-words">Conversation with {author}</span><span className="shrink-0 text-xs font-normal text-muted-foreground">{open ? "Hide" : `Show ${messages.length}`}</span>
      </button>
      {open && <ol className="space-y-3">
        {thread.map(({ message }) => {
          const { header, handling, waitingClaim, uncertain } = receiptsFor(message);
          const route = entry.threadRoutes?.[ownerThreadResponseKey(message)];
          const routed = route?.kind === "publisher" || route?.kind === "recipients";
          return <li key={messageKey(message)} className={`space-y-1 rounded-lg p-2 ${message.side === "sam" ? "bg-muted/40" : ""}`}>
            <p className="text-xs text-muted-foreground">{message.side === "sam" ? `You to ${messageRecipient(entry, record, message)}` : message.from} · <time dateTime={message.at}>{new Date(message.at).toLocaleString()}</time></p>
            <p className="whitespace-pre-wrap break-words">{message.text}</p>
            {message.side === "sam" && header && <div className="text-xs"><AnswerSteps sent={header.createdAt} acknowledgement={handling?.acknowledgement ?? null} outcome={handling?.outcome ?? null} agent={messageRecipient(entry, record, message)} final={false} /></div>}
            {message.side === "sam" && route?.kind === "held" && <p className="text-xs text-muted-foreground">Not sent: {route.unresolved.join(" / ")} had no link you approved.</p>}
            {message.side === "sam" && uncertain && !waitingClaim && !closed && <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy || !routed} className={buttonClass} onClick={() => onResend(message.text, message.messageId)}>Send again</button>
              <span className="text-xs text-muted-foreground">It may arrive twice.</span>
            </div>}
          </li>;
        })}
      </ol>}
    </div>}
    {reply ?? ("reason" in route && <p role="status" className="text-sm text-muted-foreground">{route.reason}</p>)}
    {!!heldNotes.length && <details className="rounded-xl border border-border p-3">
      <summary className="min-h-8 cursor-pointer font-medium">Held notes ({heldNotes.length})</summary>
      <ul className="mt-2 space-y-2">{heldNotes.map((note) => <li key={note.eventId} className="space-y-1 rounded-lg bg-muted/30 p-3"><p className="whitespace-pre-wrap break-words">{note.text}</p><p className="text-xs text-muted-foreground">Not sent · meant for {note.intendedRecipient} · {new Date(note.at).toLocaleString()}</p></li>)}</ul>
    </details>}
    {wiring && <details className="rounded-xl border border-border p-3 text-xs">
      <summary className="min-h-8 cursor-pointer text-sm font-medium">Delivery details</summary>
      <div className="mt-2 space-y-3 break-words">
        {"detail" in route && <p>{route.detail} Nothing is broadcast.</p>}
        {thread.map(({ message }) => {
          const { legacy, reported, handling } = receiptsFor(message);
          const origin = owner.threadOrigins?.[ownerThreadResponseKey(message)];
          const route = entry.threadRoutes?.[ownerThreadResponseKey(message)];
          return <div key={messageKey(message)} aria-label="Message delivery" className="space-y-1">
            <p className="font-medium">“{message.text.length > 60 ? `${message.text.slice(0, 60)}…` : message.text}”</p>
            <p>{message.side === "sam" ? "You" : origin?.kind === "legacy" && parseThreadKey(origin.sourceKey)?.side === "officer" ? `${message.from} · archived officer message (display name)` : origin?.kind === "agent-output" && origin.sourceId === entry.source.sourceId ? `${message.from} · registered publisher ${entry.source.label}` : `${message.from} · officer history (display name; output provenance not available)`} · {message.messageId}</p>
            {"replyTo" in message && message.replyTo && <p>Reply to {message.replyTo}</p>}
            {"resendOf" in message && message.resendOf && <p>Explicit resend of {message.resendOf}</p>}
            {message.side === "sam" && route && <p>{route.kind === "publisher" ? `To ${entry.source.label} (${entry.source.agentDid})` : route.kind === "recipients" ? `Via ${entry.source.label} to ${route.delivery.targets.map((target) => `${target.recipientKey} (${target.agentId})`).join(", ")}` : `Held: ${route.unresolved.join(" / ")} has no approved mapping. No publisher fallback.`}</p>}
            {legacy.map((receipt) => <p key={`${receipt.sourceKey}:${receipt.recipientKey}`}>{receipt.recipientKey} · {(claimDeadline(receipt.originalReceipt) ?? 0) > clock ? "Sending (legacy claim)" : receipt.state === "unconfirmed" ? "Unconfirmed" : receipt.state} · {receipt.routedTo}{receipt.reason && ` · ${receipt.reason}`}</p>)}
            {reported.map((receipt) => <p key={receipt.recipientKey}>{receipt.recipient} · Publisher-reported {receipt.state === "claimed" && Date.parse(receipt.at) + 120_000 <= clock ? "unconfirmed" : receipt.state} · {receipt.routedTo}{receipt.reason && ` · ${receipt.reason}`}</p>)}
            {handling?.acknowledgement && <p>Publisher received</p>}
            {handling?.outcome && <p>Publisher outcome: {handling.outcome.phase}</p>}
            {message.side === "sam" && !legacy.length && !reported.length && <p className="text-muted-foreground">Delivery to each agent: not reported</p>}
          </div>;
        })}
        {plainMessages.map((message) => {
          const handling = entry.responseHandling?.[message.responseId];
          return <div key={message.responseId} aria-label="Other saved card message" className="space-y-1"><p className="whitespace-pre-wrap">{message.text}</p><p>Message saved · {new Date(message.createdAt).toLocaleString()}{handling?.acknowledgement && " · Publisher received"}{handling?.outcome && ` · Publisher outcome ${handling.outcome.phase}`}</p><p className="text-muted-foreground">Not a decision on this card.</p></div>;
        })}
        {!!messages.length && <p className="text-muted-foreground">Send again saves a new message; the first one may still arrive.</p>}
      </div>
    </details>}
  </section>;
}
