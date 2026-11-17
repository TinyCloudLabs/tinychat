import type { FeedCard, FeedCardState } from "@tinycloud/sdk-services/feed";
import { redactSecrets, redactSecretsDeep } from "@tinyboilerplate/core/feed/sitrep";

/**
 * The card as Home shows it: a connected agent's card was never through the board's secret guard, so its title, body
 * and every plain payload field lose anything the guard would have refused (a one-tap approval link, a key), and show
 * "[link removed]" there. The typed record and thread (`sitrep`, `sitrepThread`) are left exactly as sent: the typed
 * record is checked whole by `parseSitrepCardPayload`, and a card it refuses stays unsupported. The same card object
 * comes back when nothing was removed.
 */
export function redactedCard(card: FeedCard): FeedCard {
  const { sitrep, sitrepThread, ...plain } = card.payload ?? {};
  const payload = redactSecretsDeep(plain);
  const title = redactSecrets(card.title);
  const body = typeof card.body === "string" ? redactSecrets(card.body) : card.body;
  if (title === card.title && body === card.body && payload === plain) return card;
  const typed = card.payload ?? {};
  return {
    ...card, title, body,
    payload: { ...payload, ...("sitrep" in typed ? { sitrep } : {}), ...("sitrepThread" in typed ? { sitrepThread } : {}) },
  };
}

export function redactedState(state: FeedCardState): FeedCardState {
  const card = redactedCard(state.card);
  return card === state.card ? state : { ...state, card };
}
