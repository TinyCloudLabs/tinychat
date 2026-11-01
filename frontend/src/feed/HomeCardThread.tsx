import { useEffect, useState } from "react";
import { ownerThreadResponseKey, parseThreadKey, publisherThreadReceipts, recentThread, type BoardRecord, type SitrepOwnerData, type ThreadMessage } from "@tinyboilerplate/core/feed/sitrep";
import type { HomeFeedEntry } from "./feedStoreTypes";

interface Props {
  entry: HomeFeedEntry;
  record: BoardRecord;
  owner: SitrepOwnerData;
  busy: boolean;
  closed: boolean;
  now: number;
  onSend: (text: string, resendOf?: string) => Promise<boolean>;
}
const buttonClass = "min-h-10 rounded-lg border border-border px-3 text-sm disabled:opacity-50";
function sameParent(entry: HomeFeedEntry, value: { cardId: string; revision: number; issuanceId: string }) { const card = entry.state.card; return card.cardId === value.cardId && card.revision === value.revision && card.issuanceId === value.issuanceId; }
function claimDeadline(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("state" in value) || value.state !== "claimed") return;
  const at = "at" in value ? value.at : "updatedAt" in value ? value.updatedAt : undefined;
  const parsed = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(parsed) ? parsed + 120_000 : undefined;
}

export function HomeCardThread({ entry, record, owner, busy, closed, now, onSend }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [localClock, setLocalClock] = useState(now);
  const clock = Math.max(now, localClock);
  const messages = recentThread(owner.threads.filter((message) => message.kind === record.kind && message.id === record.id));
  const legacyClaims = owner.deliveries.flatMap((delivery) => { const deadline = claimDeadline(delivery.originalReceipt); return deadline && deadline > clock ? [deadline] : []; });
  const liveClaims = messages.flatMap((message) => receiptsFor(message).reported.flatMap((receipt) => { const deadline = Date.parse(receipt.at) + 120_000; return receipt.state === "claimed" && deadline > clock ? [deadline] : []; }));
  const nextClaim = Math.min(...legacyClaims, ...liveClaims);
  const linked = new Set([...Object.values(owner.threadResponses ?? {}), ...(owner.outboundNotes ?? []).map((note) => note.responseId)]);
  const plainMessages = entry.responses?.filter((response) => response.kind === "message" && !linked.has(response.responseId)) ?? [];
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
    return { legacy, reported, handling, waitingClaim, uncertain };
  }
  return <div className="space-y-3">
    <button type="button" className={buttonClass} onClick={() => setOpen(!open)}>{`Message ${entry.source.label}`}</button>
    {open && <section aria-label="Card thread" className="space-y-3 rounded-xl border border-border p-3">
      <p className="text-xs text-muted-foreground">To authenticated publisher {entry.source.label} · {entry.source.agentDid}. No implicit broadcast or owner-label routing.</p>
      <ol className="space-y-3">
        {messages.map((message) => {
          const { legacy, reported, handling, waitingClaim, uncertain } = receiptsFor(message);
          const origin = owner.threadOrigins?.[ownerThreadResponseKey(message)];
          const route = entry.threadRoutes?.[ownerThreadResponseKey(message)];
          const routed = route?.kind === "publisher" || route?.kind === "recipients";
          return <li key={JSON.stringify([message.kind, message.id, message.side, message.messageId])} className="space-y-1">
            <p className="text-xs text-muted-foreground">{message.side === "sam" ? "You" : origin?.kind === "legacy" && parseThreadKey(origin.sourceKey)?.side === "officer" ? `${message.from} · archived officer message (display name)` : origin?.kind === "agent-output" && origin.sourceId === entry.source.sourceId ? `${message.from} · registered publisher ${entry.source.label}` : `${message.from} · officer history (display name; output provenance not available)`} · {new Date(message.at).toLocaleString()}</p>
            <p className="whitespace-pre-wrap">{message.text}</p>
            {"replyTo" in message && message.replyTo && <p className="text-xs">Reply to {message.replyTo}</p>}
            {"resendOf" in message && message.resendOf && <p className="text-xs">Explicit resend of {message.resendOf}</p>}
            {legacy.map((receipt) => <p key={`${receipt.sourceKey}:${receipt.recipientKey}`} className="text-xs">{receipt.recipientKey} · {(claimDeadline(receipt.originalReceipt) ?? 0) > clock ? "Sending (legacy claim)" : receipt.state === "unconfirmed" ? "Unconfirmed" : receipt.state} · {receipt.routedTo}{receipt.reason && ` · ${receipt.reason}`}</p>)}
            {reported.map((receipt) => <p key={receipt.recipientKey} className="text-xs">{receipt.recipient} · Publisher-reported {receipt.state === "claimed" && Date.parse(receipt.at) + 120_000 <= clock ? "unconfirmed" : receipt.state} · {receipt.routedTo}{receipt.reason && ` · ${receipt.reason}`}</p>)}
            {handling?.acknowledgement && <p className="text-xs">Publisher received</p>}
            {handling?.outcome && <p className="text-xs">Publisher outcome: {handling.outcome.phase}</p>}
            {!legacy.length && !reported.length && <p className="text-xs text-muted-foreground">Logical recipient delivery: not reported</p>}
            {entry.recipientRoute?.recipients.filter((recipient) => !legacy.some((receipt) => receipt.recipientKey === recipient.recipientKey) && !reported.some((receipt) => receipt.recipientKey === recipient.recipientKey)).map((recipient) => <p key={recipient.recipientKey} className="text-xs text-muted-foreground">{recipient.legacyName}: not reported</p>)}
            {message.side === "sam" && uncertain && !waitingClaim && !closed && <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{route?.kind === "publisher" ? `Explicit resend to authenticated publisher ${entry.source.label} (${entry.source.agentDid}).` : route?.kind === "recipients" ? `Explicit resend via ${entry.source.label} to ${route.delivery.targets.map((target) => `${target.recipientKey} (${target.agentId})`).join(", ")}. The original may already have reached these destinations.` : `Held / unrouted: ${route?.kind === "held" ? route.unresolved.join(" / ") : "the original destination has no approved mapping"}. No publisher fallback.`}</p>
              <button type="button" disabled={busy || !routed} className={buttonClass} onClick={() => onSend(message.text, message.messageId)}>Resend message</button>
            </div>}
          </li>;
        })}
      </ol>
      {!!plainMessages.length && <section aria-label="Other saved card messages" className="space-y-2">
        {plainMessages.map((message) => {
          const handling = entry.responseHandling?.[message.responseId];
          return <div key={message.responseId} className="rounded-lg bg-muted/30 p-3 text-sm"><p className="whitespace-pre-wrap">{message.text}</p><p className="text-xs">Message saved · {new Date(message.createdAt).toLocaleString()}{handling?.acknowledgement && " · Publisher received"}{handling?.outcome && ` · Publisher outcome ${handling.outcome.phase}`}</p><p className="text-xs text-muted-foreground">Logical recipient delivery: not reported. This message is not a question decision.</p></div>;
        })}
      </section>}
      <p className="text-xs text-muted-foreground">An explicit resend creates a new immutable message. An unconfirmed original may already have arrived.</p>
      <label className="block">Message<textarea aria-label="Card message" value={text} onInput={(event) => setText(event.currentTarget.value)} disabled={closed || busy} className="mt-2 min-h-20 w-full rounded-xl border border-border bg-background p-3 text-sm" /></label>
      <button type="button" className={buttonClass} disabled={closed || busy || !text.trim()} onClick={() => { void onSend(text).then((saved) => { if (saved) setText(""); }); }}>Send message</button>
    </section>}
  </div>;
}
