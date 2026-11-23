import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { feedCardTarget, PATHS } from "../shell/routes";
import { SETUP_CHOICE_PARAM } from "./setupChoice";

/** The Feed card the address names (/chat/feed/<card id>), and what the page may do about it. */
export interface FeedCardLink {
  /** The card's lineage id, lowercase. Only ever compared with loaded cards: it is never navigated to. */
  cardId: string;
  setupChoice?: boolean;
  /** One visit to the address. Opening the same link again is a new visit, which is handled again. */
  visit: string;
  /** Closes the "not available" note: the plain Feed replaces the address, so Back never returns to it. */
  dismiss: () => void;
}

export function useFeedCardLink(): FeedCardLink | null {
  const { pathname, search, key } = useLocation();
  const navigate = useNavigate();
  const cardId = feedCardTarget(pathname);
  const setupChoice = new URLSearchParams(search).get(SETUP_CHOICE_PARAM) === "1";
  return useMemo(() => cardId ? { cardId, setupChoice, visit: key, dismiss: () => navigate(PATHS.feed, { replace: true }) } : null, [cardId, setupChoice, key, navigate]);
}
