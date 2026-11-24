import type { FeedCard, FeedCardState } from "@tinycloud/sdk-services/feed";
import { redactSecrets, redactSecretsDeep } from "@tinyboilerplate/core/feed/sitrep";
import { shownTitle } from "./cardTitle";

/**
 * The card as Home shows it: a connected agent's card was never through the board's secret guard, so its title, body
 * and every plain payload field lose anything the guard would have refused (a one-tap approval link, a key), and show
 * "[link removed]" there, as do the labels of its answer buttons. The title also loses any link or token (shownTitle);
 * a message relayed over Courier (`courier`: the verified Courier connection's card) is titled by a short summary.
 * The typed record and thread (`sitrep`, `sitrepThread`) are left exactly as sent: the typed
 * record is checked whole by `parseSitrepCardPayload`, and a card it refuses stays unsupported. The same card object
 * comes back when nothing was removed.
 */
export function redactedCard(card: FeedCard, courier = false): FeedCard {
  const { sitrep, sitrepThread, ...plain } = card.payload ?? {};
  const payload = redactSecretsDeep(plain);
  const title = shownTitle(card.title, courier);
  const body = typeof card.body === "string" ? redactSecrets(card.body) : card.body;
  // An answer button's words are the agent's too. Only the label: an option's id is what a saved answer is matched on.
  const labels = card.choices?.map((choice) => ({ choice, label: redactSecrets(choice.label) }));
  const choicesChanged = labels?.some(({ choice, label }) => label !== choice.label) ?? false;
  if (title === card.title && body === card.body && payload === plain && !choicesChanged) return card;
  const typed = card.payload ?? {};
  return {
    ...card, title, body,
    ...(labels ? { choices: labels.map(({ choice, label }) => (label === choice.label ? choice : { ...choice, label })) } : {}),
    payload: { ...payload, ...("sitrep" in typed ? { sitrep } : {}), ...("sitrepThread" in typed ? { sitrepThread } : {}) },
  };
}

export function redactedState(state: FeedCardState, courier = false): FeedCardState {
  const card = redactedCard(state.card, courier);
  return card === state.card ? state : { ...state, card };
}
