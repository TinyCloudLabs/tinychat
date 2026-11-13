import { useEffect, useState, type ReactNode } from "react";
import { ownerThreadResponseKey, parseThreadKey, publisherThreadReceipts, recentThread, type BoardRecord, type SitrepOwnerData, type ThreadMessage } from "@tinyboilerplate/core/feed/sitrep";
import type { HomeFeedEntry } from "./feedStoreTypes";
import { CardConversation, isOwnerAction, type ConversationLine } from "./CardConversation";

interface Props {
  entry: HomeFeedEntry;
  record: BoardRecord;
  owner: SitrepOwnerData;
  busy: boolean;
  closed: boolean;
  /** A newer issuance replaced this card: a comment still in its undo window is refused, not sent. */
  stale?: boolean;
  now: number;
  /** The card is open: its comments show. */
  open: boolean;
  /** Who a comment goes to ("Leave a comment for {to}"); none, no comment control (`reason` says why). */
  to?: string;
  reason?: string;
  /** The comment box, opened from the card's "Comment" foot action; without it, a closed box opens it. */
  composer?: { open: boolean; onOpenChange: (open: boolean) => void };
  onSend: (text: string) => Promise<boolean>;
  onResend: (text: string, resendOf: string) => Promise<boolean>;
}
function sameParent(entry: HomeFeedEntry, value: { cardId: string; revision: number; issuanceId: string }) { const card = entry.state.card; return card.cardId === value.cardId && card.revision === value.revision && card.issuanceId === value.issuanceId; }
function claimDeadline(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("state" in value) || value.state !== "claimed") return;
  const at = "at" in value ? value.at : "updatedAt" in value ? value.updatedAt : undefined;
  const parsed = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(parsed) ? parsed + 120_000 : undefined;
}

/** How many comments a typed card has (the collapsed card shows the count). Owner card actions ("feed.*") are not comments. */
export function threadSize(entry: HomeFeedEntry, record: BoardRecord, owner: SitrepOwnerData): number {
  const linked = new Set([...Object.values(owner.threadResponses ?? {}), ...(owner.outboundNotes ?? []).map((note) => note.responseId)]);
  return owner.threads.filter((message) => message.kind === record.kind && message.id === record.id).length
    + (entry.responses?.filter((response) => response.kind === "message" && !isOwnerAction(response) && !linked.has(response.responseId)).length ?? 0)
    + (owner.heldNotes?.length ?? 0);
}

/**
 * A typed card's conversation: the owner's thread messages and the agent's (a `replyTo` names the
 * owner message answered), plain card messages, and notes kept privately. Typed routing and receipts
 * stay: per-recipient states show under the comment, an unconfirmed or claim-expired receipt marks it
 * unconfirmed at once, and "Send again" resends with `resendOf` only to a routed message.
 */
export function HomeCardThread({ entry, record, owner, busy, closed, stale = false, now, open, to, reason, composer, onSend, onResend }: Props) {
  const [localClock, setLocalClock] = useState(now);
  const clock = Math.max(now, localClock);
  const agent = entry.source.label;
  const messages = recentThread(owner.threads.filter((message) => message.kind === record.kind && message.id === record.id));
  const legacyClaims = owner.deliveries.flatMap((delivery) => { const deadline = claimDeadline(delivery.originalReceipt); return deadline && deadline > clock ? [deadline] : []; });
  const liveClaims = messages.flatMap((message) => receiptsFor(message).reported.flatMap((receipt) => { const deadline = Date.parse(receipt.at) + 120_000; return receipt.state === "claimed" && deadline > clock ? [deadline] : []; }));
  const nextClaim = Math.min(...legacyClaims, ...liveClaims);
  const linked = new Set([...Object.values(owner.threadResponses ?? {}), ...(owner.outboundNotes ?? []).map((note) => note.responseId)]);
  const plainMessages = entry.responses?.filter((response) => response.kind === "message" && !!response.text && !isOwnerAction(response) && !linked.has(response.responseId)) ?? [];
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
  function ownLine(message: ThreadMessage): ConversationLine {
    const { legacy, reported, handling, waitingClaim, uncertain } = receiptsFor(message);
    const route = entry.threadRoutes?.[ownerThreadResponseKey(message)];
    const routed = route?.kind === "publisher" || route?.kind === "recipients";
    const states = [
      ...legacy.map((receipt) => `${entry.recipientRoute?.recipients.find((recipient) => recipient.recipientKey === receipt.recipientKey)?.legacyName ?? receipt.recipientKey}: ${receipt.state === "unconfirmed" ? "Unconfirmed" : receipt.state}`),
      ...reported.map((receipt) => `${receipt.recipient}: ${receipt.state === "claimed" && Date.parse(receipt.at) + 120_000 <= clock ? "Unconfirmed" : receipt.state}`),
    ];
    const heldRoute = uncertain && !waitingClaim && (route?.kind === "held" || !routed);
    const note: ReactNode = states.length || heldRoute ? <>
      {!!states.length && <span className="block">{states.join(" · ")}</span>}
      {heldRoute && <span className="block">Kept private, not sent: {route?.kind === "held" ? route.unresolved.join(" / ") : "the first recipient"} isn't connected.</span>}
    </> : undefined;
    return { key: `me:${message.messageId}`, id: message.messageId, mine: true, text: message.text, at: message.at, who: to ?? agent,
      received: !!handling?.acknowledgement, ...(uncertain && !waitingClaim ? { uncertain: true } : {}), ...(!routed || closed ? { noResend: true } : {}), ...(note ? { note } : {}) };
  }

  const lines: ConversationLine[] = [
    ...messages.map((message) => {
      if (message.side === "sam") return ownLine(message);
      const origin = owner.threadOrigins?.[ownerThreadResponseKey(message)];
      // Only output this card's registered agent published carries its name; archived
      // officer messages keep the display name they were written with.
      const who = origin?.kind === "agent-output" && origin.sourceId === entry.source.sourceId ? agent : message.from;
      return { key: `agent:${message.messageId}`, mine: false, text: message.text, at: message.at, who, ...(message.replyTo ? { replyTo: `me:${message.replyTo}` } : {}) };
    }),
    ...plainMessages.map((message) => ({ key: `me:${message.responseId}`, id: message.responseId, mine: true, text: message.text ?? "", at: message.createdAt, who: agent, noResend: true,
      received: !!entry.responseHandling?.[message.responseId]?.acknowledgement })),
    ...(owner.heldNotes ?? []).map((note) => ({ key: `held:${note.eventId}`, mine: true, text: note.text, at: note.at, who: note.intendedRecipient, held: true })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return <CardConversation lines={lines} to={closed ? undefined : to} reason={reason} disabled={busy || closed} stale={stale} visible={open} composer={composer}
    onSend={onSend} onResend={(line) => line.id ? onResend(line.text, line.id) : Promise.resolve(false)} />;
}
