import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { feedCardTarget, PATHS } from "../shell/routes";

/** The Feed card the address names (/chat/feed/<card id>), and what the page may do about it. */
export interface FeedCardLink {
  /** The card's lineage id, lowercase. Only ever compared with loaded cards: it is never navigated to. */
  cardId: string;
  /** One visit to the address. Opening the same link again is a new visit, which is handled again. */
  visit: string;
  /** Closes the "not available" note: the plain Feed replaces the address, so Back never returns to it. */
  dismiss: () => void;
}

export function useFeedCardLink(): FeedCardLink | null {
  const { pathname, key } = useLocation();
  const navigate = useNavigate();
  const cardId = feedCardTarget(pathname);
  return useMemo(() => cardId ? { cardId, visit: key, dismiss: () => navigate(PATHS.feed, { replace: true }) } : null, [cardId, key, navigate]);
}
