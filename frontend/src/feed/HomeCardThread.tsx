import { useEffect, useState, type ReactNode } from "react";
import { ownerThreadResponseKey, parseThreadKey, publisherThreadReceipts, recentThread, type BoardRecord, type SitrepOwnerData, type ThreadMessage } from "@tinyboilerplate/core/feed/sitrep";
import type { HomeFeedEntry } from "./feedStoreTypes";
import { cardTime, pillClass as buttonClass, quietClass } from "./cardKit";

interface Props {
  entry: HomeFeedEntry;
  record: BoardRecord;
  owner: SitrepOwnerData;
  busy: boolean;
  closed: boolean;
  now: number;
  /** The composer is open. */
  composing: boolean;
  /** The composer's name: "Ask Helper agent something". */
  ask: string;
  /** Who sees a new message: "Only Helper agent sees this." */
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

export interface ThreadItem { key: string; at: string; speaker: string; text: string; status?: ReactNode }

/** How many messages a typed card's thread shows: the card puts its answer first when there are more than 2. */
export function threadSize(entry: HomeFeedEntry, record: BoardRecord, owner: SitrepOwnerData): number {
  const linked = new Set([...Object.values(owner.threadResponses ?? {}), ...(owner.outboundNotes ?? []).map((note) => note.responseId)]);
  return owner.threads.filter((message) => message.kind === record.kind && message.id === record.id).length
    + (entry.responses?.filter((response) => response.kind === "message" && !linked.has(response.responseId)).length ?? 0)
    + (owner.heldNotes?.length ?? 0);
}

/**
 * A card's conversation: messages oldest first (only the latest 2 until "Show N earlier
 * messages"), then the one-line composer when it is open.
 */
export function ThreadView({ items, now, composing, ask, helper, busy, closed, onSend, onClose }: {
  items: readonly ThreadItem[]; now: number; composing: boolean;
  /** The composer's name: "Ask Helper agent something". */
  ask: string;
  /** Who sees a new message: "Only Helper agent sees this." */
  helper: string;
  busy: boolean; closed: boolean;
  onSend: (text: string) => Promise<boolean>; onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
  const hidden = all ? 0 : Math.max(0, sorted.length - 2);
  if (!sorted.length && !composing) return null;
  return <section aria-label="Card thread" className="mt-3.5 space-y-2.5">
    {hidden > 0 && <button type="button" className={`${quietClass} -my-2`} onClick={() => setAll(true)}>{`Show ${hidden} earlier ${hidden === 1 ? "message" : "messages"}`}</button>}
    {!!sorted.length && <ol className="space-y-2.5">
      {sorted.slice(hidden).map((item) => <li key={item.key} className="min-w-0">
        <p className="text-[13px] leading-[18px]"><span className="font-semibold">{item.speaker}</span> <span className="tabular-nums text-muted-foreground">· <time dateTime={item.at}>{cardTime(item.at, now)}</time></span></p>
        <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.45]">{item.text}</p>
        {item.status && <p className="text-[13px] text-muted-foreground">{item.status}</p>}
      </li>)}
    </ol>}
    {composing && <form onSubmit={(event) => { event.preventDefault(); if (text.trim()) void onSend(text.trim()).then((saved) => { if (saved) setText(""); }); }}>
      <div className="flex items-center gap-2">
        <input aria-label={ask} value={text} autoFocus onInput={(event) => setText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }} disabled={closed || busy} placeholder={ask}
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
 * The card's conversation, inline under its body: the owner's messages and the agent's
 * replies, oldest first, then the one-line composer when it is open.
 */
export function HomeCardThread({ entry, record, owner, busy, closed, now, composing, ask, helper, onSend, onResend, onClose }: Props) {
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
      return { key: `thread:${message.side}:${message.messageId}`, at: message.at, speaker, text: message.text, ...(message.side === "sam" ? { status: ownStatus(message) } : {}) };
    }),
    ...plainMessages.map((message) => ({ key: `message:${message.responseId}`, at: message.createdAt, speaker: "You", text: message.text ?? "",
      status: entry.responseHandling?.[message.responseId]?.acknowledgement ? <span>{agent} got it</span> : undefined })),
    ...(owner.heldNotes ?? []).map((note) => ({ key: `held:${note.eventId}`, at: note.at, speaker: "You", text: note.text,
      status: <span>Kept private, not sent: {note.intendedRecipient} isn't connected yet.</span> })),
  ];
  return <ThreadView items={items} now={clock} composing={composing} ask={ask} helper={helper} busy={busy} closed={closed} onSend={onSend} onClose={onClose} />;
}
