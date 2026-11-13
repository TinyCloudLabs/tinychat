import type { SitrepProjection } from "@tinyboilerplate/core/feed/sitrep";
import type { HomeFeedEntry } from "./feedStoreTypes";

/** What came of the card's latest answer, once its agent reports it. */
function outcomeWord(entry: HomeFeedEntry): string | undefined {
  const outcome = entry.state.outcome;
  const latest = entry.state.response;
  return !outcome || (latest && latest.kind !== "message" && latest.responseId !== outcome.responseId) ? undefined : outcome.phase === "failed" ? "Failed" : "Done";
}

/**
 * One plain word for where a card stands, the same on the card and in the list: "Needs you", "Waiting on <agent>",
 * "Done", or the state it is in (Snoozed, Expired, Closed, Not needed, Information). `typed` is a typed card's
 * projection; a plain card goes by its answer and its agent's report.
 */
export function cardStatus(entry: HomeFeedEntry, typed: SitrepProjection | undefined, now: number, agent: string): string {
  const snoozed = Date.parse(entry.view.snoozedUntil ?? "") > now;
  if (typed) {
    switch (typed.attention) {
      case "expired": return "Expired";
      case "closed": return "Closed";
      case "snoozed": return "Snoozed";
      case "not-needed": return "Not needed";
      case "needs-action": return snoozed ? "Snoozed" : "Needs you";
      case "handled": return outcomeWord(entry) ?? `Waiting on ${agent}`;
      default: return "Information";
    }
  }
  if (snoozed) return "Snoozed";
  if (!entry.state.card.needsResponse) return "Information";
  if (!entry.state.response) return "Needs you";
  return outcomeWord(entry) ?? `Waiting on ${agent}`;
}
