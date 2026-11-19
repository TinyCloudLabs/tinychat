import type { FeedCard, FeedSource } from "@tinycloud/sdk-services/feed";
import type { HomeFeedEntry } from "./feedStoreTypes";

/** A stored revision Home didn't load as an entry: it has no response, message or view of its own. */
export function storedRevisionEntry(source: FeedSource, card: FeedCard): HomeFeedEntry {
  return { source, state: { card, response: null, acknowledgement: null, outcome: null }, view: { sourceId: source.sourceId, cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId }, responses: [] };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
/**
 * True only when `next` is `previous` plus appended agent replies: the same card from the
 * same agent, a higher revision, every card field and payload key structurally identical
 * (canonical JSON) except `payload.replies`, and those replies a strict append (the first k
 * identical, at least one more). The single exception: the revision that adds a "post"
 * card's first reply may also change `payload.render` from "post" (or absent) to "thread". Revision,
 * issuance and createdAt are the revision's own identity and time, so they are not compared.
 */
export function isReplyOnlyRevision(previous: HomeFeedEntry, next: HomeFeedEntry): boolean {
  if (previous.source.sourceId !== next.source.sourceId || previous.source.agentDid !== next.source.agentDid) return false;
  const before = previous.state.card; const after = next.state.card;
  if (before.cardId !== after.cardId || after.revision <= before.revision) return false;
  const { revision: _r1, issuanceId: _i1, createdAt: _c1, payload: beforePayload = {}, ...beforeFields } = before;
  const { revision: _r2, issuanceId: _i2, createdAt: _c2, payload: afterPayload = {}, ...afterFields } = after;
  if (canonical(beforeFields) !== canonical(afterFields)) return false;
  const { replies: beforeReplies = [], ...beforeOthers } = beforePayload;
  const { replies: afterReplies, ...afterOthers } = afterPayload;
  if (!Array.isArray(beforeReplies) || !Array.isArray(afterReplies) || afterReplies.length <= beforeReplies.length) return false;
  // The one allowed extra change: a "post" card's first reply turns it into a "thread". An
  // absent render (or payload) is a post here, and only here.
  const firstReply = (beforeOthers.render === undefined || beforeOthers.render === "post") && afterOthers.render === "thread" && beforeReplies.length === 0;
  const { render: _beforeRender, ...beforeRest } = beforeOthers;
  const { render: _afterRender, ...afterRest } = afterOthers;
  if (firstReply ? canonical(beforeRest) !== canonical(afterRest) : canonical(beforeOthers) !== canonical(afterOthers)) return false;
  return beforeReplies.every((reply, index) => canonical(reply) === canonical(afterReplies[index]));
}
