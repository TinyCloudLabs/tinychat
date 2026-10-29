import type { FeedCardIdentity } from "@tinycloud/sdk-services/feed";
import type { HomeFeedEntry } from "./feedStoreTypes";

export function ownerCardKey(sourceId: string, card: FeedCardIdentity): string {
  return JSON.stringify([sourceId, card.cardId, card.revision, card.issuanceId]);
}
export function homeFeedKey(entry: HomeFeedEntry): string { return ownerCardKey(entry.source.sourceId, entry.state.card); }
function shortReference(entry: HomeFeedEntry): string {
  const card = entry.state.card;
  return `F-${card.cardId.slice(0, 8)}/${card.revision}/${card.issuanceId.slice(0, 8)}`;
}
/** Display only. All reads/writes still require the complete canonical identity. */
export function humanFeedReference(entry: HomeFeedEntry, entries: readonly HomeFeedEntry[]): string {
  const short = shortReference(entry);
  return entries.some((other) => homeFeedKey(other) !== homeFeedKey(entry) && shortReference(other) === short)
    ? `${entry.source.sourceId}:${entry.state.card.cardId}/${entry.state.card.revision}/${entry.state.card.issuanceId}`
    : short;
}
