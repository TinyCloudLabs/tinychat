import type { FeedCardIdentity } from "@tinycloud/sdk-services/feed";
import type { HomeFeedEntry } from "./feedStoreTypes";
import { parseOwnerJSON } from "./privateFeedDatabase";

export function ownerCardKey(sourceId: string, card: FeedCardIdentity): string {
  return JSON.stringify([sourceId, card.cardId, card.revision, card.issuanceId]);
}
export function homeFeedKey(entry: HomeFeedEntry): string { return ownerCardKey(entry.source.sourceId, entry.state.card); }

/** Only a validated archive origin joins sources; snapshot IDs are not preference namespaces. */
export function homeGroupScope(sourceId: string, modelScope?: string): string {
  if (modelScope === undefined) return JSON.stringify(["source", sourceId]);
  const origin = parseOwnerJSON(modelScope, "Invalid validated Home archive scope");
  if (!Array.isArray(origin) || origin.length !== 3 || typeof origin[0] !== "string" || !origin[0] || typeof origin[1] !== "string" || !origin[1] || typeof origin[2] !== "string" || !origin[2]) throw new Error("Invalid validated Home archive scope");
  return JSON.stringify(["archive", origin[0], origin[1]]);
}
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
