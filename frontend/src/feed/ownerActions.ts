import type { FeedResponse, FeedResponseIdentity, FeedResponsePayload, NewFeedMessage } from "@tinycloud/sdk-services/feed";

/**
 * The owner's card actions an agent hears about (names agreed with the card guide): Ask me later, Drop this
 * card and Acknowledge. Each is a `message` response with an agent-readable header and a private payload
 * (version 1). The agent acknowledges it with no reply.
 */
export type OwnerAction = { type: "feed.drop" } | { type: "feed.acknowledge" } | { type: "feed.snooze"; until: string };

const OWNER_ACTION_TYPES: ReadonlySet<string> = new Set(["feed.drop", "feed.acknowledge", "feed.snooze"]);
const SNOOZE_PREFIX = "Ask me later: ";

/** A well-formed owner action: a known type, and a snooze with a parseable `until`. */
export function validOwnerAction(value: unknown): value is OwnerAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (typeof action.type !== "string" || !OWNER_ACTION_TYPES.has(action.type)) return false;
  if (action.type !== "feed.snooze") return true;
  return typeof action.until === "string" && Number.isFinite(Date.parse(action.until));
}

/** The header text the agent reads: "Ask me later: <ISO until>", "Dropped" or "Acknowledged". */
export function ownerActionText(action: OwnerAction): string {
  if (action.type === "feed.snooze") return `${SNOOZE_PREFIX}${action.until}`;
  return action.type === "feed.drop" ? "Dropped" : "Acknowledged";
}

/** The message and private payload for an owner action on one exact card identity. */
export function ownerActionMessage(action: OwnerAction, identity: FeedResponseIdentity, createdAt: string): { message: NewFeedMessage; payload: FeedResponsePayload } {
  if (!validOwnerAction(action)) throw new Error("Invalid owner card action");
  return {
    message: { responseId: identity.responseId, cardId: identity.cardId, revision: identity.revision, issuanceId: identity.issuanceId, kind: "message", text: ownerActionText(action), createdAt },
    payload: { type: action.type, version: 1, data: action.type === "feed.snooze" ? { until: action.until } : {} },
  };
}

/**
 * Whether a stored response is an owner action rather than something the owner said: a `message` whose private
 * payload type starts with "feed.". Never a chat bubble, never counted as a comment. (A post's `feed.page` answer is
 * an answer, not a message, so it is not an owner action.)
 */
export function isOwnerAction(response: Pick<FeedResponse, "kind" | "payloadType">): boolean {
  return response.kind === "message" && !!response.payloadType?.startsWith("feed.");
}

/**
 * How the owner closed a card, if they did: the latest Drop or Acknowledge, by response sequence. A later answer or
 * comment does not reopen it; only the agent's next request (a new, non-reply-only revision) does.
 *
 * Responses are stored per exact card identity (cardId, revision, issuance), and an agent's reply arrives as a new
 * revision. Pass the responses of the card's whole reply-only lineage (every revision `revisionsOf`/`replyChain`
 * links to the shown one), not just `entry.responses`, or a card dropped on one revision comes back on the agent's
 * next reply. Sequences compare within one agent's response database, which is where one card's responses live.
 */
export function ownerClosure(responses: readonly FeedResponse[]): "Dropped" | "Acknowledged" | undefined {
  let latest: FeedResponse | undefined;
  for (const response of responses) {
    if (response.kind !== "message" || (response.payloadType !== "feed.drop" && response.payloadType !== "feed.acknowledge")) continue;
    if (!latest || response.sequence > latest.sequence) latest = response;
  }
  if (!latest) return undefined;
  return latest.payloadType === "feed.drop" ? "Dropped" : "Acknowledged";
}
