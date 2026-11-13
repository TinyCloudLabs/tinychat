import type { SitrepProjection } from "@tinyboilerplate/core/feed/sitrep";
import type { HomeFeedEntry } from "./feedStoreTypes";

/** The latest answer's handling, of the given phase, once its agent records it; an earlier answer's never counts. */
function latestHandling(entry: HomeFeedEntry, handling: "acknowledgement" | "outcome") {
  const record = entry.state[handling];
  const latest = entry.state.response;
  return !record || (latest && latest.kind !== "message" && latest.responseId !== record.responseId) ? undefined : record;
}

/** What came of the card's latest answer: Done or Failed once its agent reports it, Answered once it acknowledges it. */
function outcomeWord(entry: HomeFeedEntry): string | undefined {
  const outcome = latestHandling(entry, "outcome");
  if (outcome) return outcome.phase === "failed" ? "Failed" : "Done";
  return latestHandling(entry, "acknowledgement") ? "Answered" : undefined;
}

/**
 * One plain word for where a card stands, the same on the card and in the list: "Needs you", "Waiting on <agent>",
 * "Answered" (the agent acknowledged the answer), "Done", or the state it is in (Snoozed, Expired, Closed, Not needed,
 * Information). `typed` is a typed card's projection; a plain card goes by its answer and its agent's report.
 */
export function cardStatus(entry: HomeFeedEntry, typed: SitrepProjection | undefined, now: number, agent: string): string {
  const snoozed = Date.parse(entry.view.snoozedUntil ?? "") > now;
  if (typed) {
    switch (typed.attention) {
      case "expired": return "Expired";
      case "closed": return typed.answer ? "Answered" : "Closed";
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
