import { feedResourceNames } from "@tinycloud/sdk-services/feed";
import { feedCardPath } from "../shell/routes";
import type { HomeFeedEntry } from "./feedStoreTypes";

export const SETUP_CHOICE_PARAM = "setup";

function setupCardId(handoffId: string): string | undefined {
  const parts = /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/.exec(handoffId);
  return parts?.slice(1).join("-");
}

/** The handoff id comes from the verified record key. Only this card address goes to sign-in. */
export function handoffChoicePath(handoffId: string): string | null {
  const cardId = setupCardId(handoffId);
  return cardId ? `${feedCardPath(cardId)}?${SETUP_CHOICE_PARAM}=1` : null;
}

// The setup token is bound to one agent in the owner’s Feed registry.
export function isSetupChoice(entry: HomeFeedEntry): boolean {
  const { cardId } = entry.state.card;
  const handoffId = cardId.replaceAll("-", "");
  return setupCardId(handoffId) === cardId
    && entry.source.sourceId === `setup-${handoffId}`;
}

export function isSetupChoiceIssuance(entry: HomeFeedEntry): boolean {
  const { card } = entry.state;
  if (!isSetupChoice(entry) || card.revision !== 1 || card.issuanceId !== card.cardId
      || card.kind !== "decision" || !card.needsResponse || !card.choices?.length
      || card.payload?.sitrep !== undefined || card.payload?.page !== undefined) return false;
  const resources = feedResourceNames("xyz.tinycloud.tinychat/feed", entry.source.sourceId);
  return resources.ok && resources.data.outputResource === entry.source.output.database
    && resources.data.responseResource === entry.source.responses.database;
}
