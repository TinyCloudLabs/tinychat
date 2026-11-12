// Replying to the agent behind a typed card: who can act on a reply (replyRoute), the one box that sends it with
// the answers' undo window (ReplyBox), and the message it saves (postReply). The card (SitrepCard.tsx), its folded
// line and the conversation with one agent (AgentConversation.tsx) share them, so a reply reads and goes the same
// way from each. A reply reaches only destinations the person approved: the posting agent, or the agents linked
// for the card's owner. It is never broadcast.
import { useRef, useState } from "react";
import type { FeedResponse, FeedResponsePayload, NewFeedMessage } from "@tinycloud/sdk-services/feed";
import { compactStamp, isClosed, jsonValue, safeSitrepActionSummary, threadOwner, validateSitrepAction, type BoardRecord, type SitrepMessageDelivery } from "@tinyboilerplate/core/feed/sitrep";
import { sendingLabel, useUndoWindow } from "./AnswerOptions";
import type { HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";

/** Who a typed card is from: the crew member named on it, which may post through another agent's connection. */
export function cardAuthor(entry: HomeFeedEntry, record?: BoardRecord): { name: string; via?: string } {
  const from = record?.from.trim();
  return from && from !== entry.source.label ? { name: from, via: entry.source.label } : { name: entry.source.label };
}

export type ReplyRoute =
  /** `to` names who receives it; `delivery` is set only for agents the person linked for the card's owner. */
  | { to: string; delivery?: SitrepMessageDelivery; detail: string }
  | { to?: undefined; reason: string };

/**
 * The agent that can act on a reply: the card's owner when the person approved a link to it, else the agent that
 * posted the card. A closed card, or a source that cannot carry messages, takes no reply.
 */
export function replyRoute(entry: HomeFeedEntry, record: BoardRecord, source: HomeFeedSource): ReplyRoute {
  const author = cardAuthor(entry, record).name;
  if (isClosed(record)) return { reason: `This card is closed, so ${author} takes no replies on it.` };
  if (!source.sendMessage) return { reason: "No agent can receive a reply here." };
  const route = entry.recipientRoute;
  const linked = route?.recipients.flatMap((recipient) => recipient.runtimeTarget ? [{ ...recipient, runtimeTarget: recipient.runtimeTarget }] : []) ?? [];
  const unlinked = [...new Set([...(route?.unresolved ?? []), ...(route?.recipients.filter((recipient) => !recipient.runtimeTarget).map((recipient) => recipient.legacyName) ?? [])])];
  const skipped = unlinked.length ? ` ${unlinked.join(" / ")} ${unlinked.length > 1 ? "have" : "has"} no link you approved and does not get it.` : "";
  if (linked.length) {
    const to = linked.map((recipient) => recipient.legacyName).join(" / ");
    return {
      to, delivery: { version: 1, targets: linked.map((recipient) => ({ recipientKey: recipient.recipientKey, agentId: recipient.runtimeTarget.agentId, ...(recipient.runtimeTarget.provider ? { provider: recipient.runtimeTarget.provider } : {}) })) },
      detail: `Replies go straight to ${linked.map((recipient) => `${recipient.legacyName} (${recipient.runtimeTarget.agentId})`).join(", ")}, through ${entry.source.label}. You linked ${linked.length > 1 ? "them" : "it"}; only linked agents receive a reply.${skipped}`,
    };
  }
  const owner = threadOwner(record);
  return { to: author, detail: `Replies go to ${entry.source.label}, the agent that posted this card (${entry.source.agentDid}).${owner !== author && owner !== entry.source.label ? ` ${owner} is working on it, but you have not linked it, so it can only hear through ${entry.source.label}.` : ""}${skipped}` };
}

/** The saved message: the same immutable `sitrep.thread` event the card's thread has always sent. */
export function replyDraft(entry: HomeFeedEntry, record: BoardRecord, text: string, delivery?: SitrepMessageDelivery, resendOf?: string): { header: NewFeedMessage; payload: FeedResponsePayload } {
  const at = new Date().toISOString();
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const action = validateSitrepAction(record, "sitrep.thread", { side: "sam", kind: record.kind, id: record.id, at, text, messageId: `${compactStamp(at)}-${nonce}`, ...(resendOf ? { resendOf } : {}), ...(delivery ? { delivery } : {}) }, at);
  const card = entry.state.card;
  const data = action.type === "sitrep.thread" && action.delivery ? { ...action.value, delivery: action.delivery } : action.value;
  return {
    header: { responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, createdAt: at, text: safeSitrepActionSummary(action), kind: "message" },
    payload: { type: "sitrep.thread", version: 1, data: jsonValue(data) },
  };
}

/** Sends a reply. A retry of the same words reuses the draft, so a lost save cannot become a second message. */
export function usePostReply(entry: HomeFeedEntry, record: BoardRecord, source: HomeFeedSource, onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void) {
  const pending = useRef<{ text: string; resendOf?: string; draft: ReturnType<typeof replyDraft> } | undefined>(undefined);
  // `resendOf`: "Send again" names the comment it repeats, so the agent and the thread can tell the copy apart.
  return async (text: string, delivery?: SitrepMessageDelivery, resendOf?: string) => {
    if (!source.sendMessage) throw new Error("No agent can receive a reply here");
    const draft = pending.current?.text === text && pending.current.resendOf === resendOf ? pending.current.draft : replyDraft(entry, record, text, delivery, resendOf);
    pending.current = { text, resendOf, draft };
    const result = await source.sendMessage(entry, draft.header, draft.payload);
    pending.current = undefined;
    onSaved(entry, result);
    return result;
  };
}

/**
 * The one place to write under a card, labelled with who gets it. Send waits out the same undo window as an answer
 * ("Sending to Studio agent in 4s", Undo), then saves; the words stay if the save fails, with Try again.
 */
export function ReplyBox({ to, onSend, disabled = false, about, autoFocus = false }: {
  to: string;
  onSend: (text: string) => Promise<unknown>;
  disabled?: boolean;
  /** The card a reply is about, when the box is not under it. */
  about?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const latest = useRef(text);
  latest.current = text;
  async function send() {
    const value = latest.current.trim();
    if (!value) return;
    setSaving(true); setError(undefined);
    try { await onSend(value); setText(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Reply could not be sent"); }
    finally { setSaving(false); }
  }
  const hold = useUndoWindow(() => void send());
  const waiting = saving || hold.seconds !== null;
  return <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (!waiting && text.trim()) hold.start(); }}>
    <label className="block font-medium">Reply to {to}{about && <span className="block text-xs font-normal text-muted-foreground">About: {about}</span>}
      <textarea name="reply" aria-label={`Reply to ${to}`} autoFocus={autoFocus} value={text} disabled={disabled || waiting} onInput={(event) => setText(event.currentTarget.value)} className="mt-2 min-h-20 w-full rounded-xl border border-border bg-background p-3 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
    </label>
    {error && !waiting && <div role="alert" className="text-destructive"><p>{error}</p><button type="button" className="mt-1 min-h-9 underline" onClick={() => void send()}>Try again</button></div>}
    <div className="flex flex-wrap items-center gap-2">
      <button className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50" disabled={disabled || waiting || !text.trim()}>{waiting ? sendingLabel(hold.seconds, "Sending", to) : "Send"}</button>
      {hold.seconds !== null && <button type="button" onClick={hold.undo} className="min-h-11 rounded-lg border border-border px-4 text-sm font-medium">Undo</button>}
    </div>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{hold.status}</p>
  </form>;
}
