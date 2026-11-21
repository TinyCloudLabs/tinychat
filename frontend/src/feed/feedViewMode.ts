// How the feed lists its cards, kept per device (localStorage), the same in Needs you, All and History.
// Compact: the rows the feed has always had. Expanded: every card open in full, one after another. Cards: tiles in a grid.
export type FeedViewMode = "compact" | "expanded" | "cards";

export const FEED_VIEW_MODES: readonly FeedViewMode[] = ["compact", "expanded", "cards"];
export const DEFAULT_FEED_VIEW_MODE: FeedViewMode = "compact";
export const FEED_VIEW_MODE_KEY = "tinychat:feed-view-mode:v1";

/** The saved choice, or the default when nothing, something unknown, or no storage is there. */
export function readFeedViewMode(): FeedViewMode {
  try {
    const saved = window.localStorage.getItem(FEED_VIEW_MODE_KEY);
    return FEED_VIEW_MODES.find((mode) => mode === saved) ?? DEFAULT_FEED_VIEW_MODE;
  } catch { return DEFAULT_FEED_VIEW_MODE; }
}

export function saveFeedViewMode(mode: FeedViewMode): void {
  try { window.localStorage.setItem(FEED_VIEW_MODE_KEY, mode); }
  catch { /* localStorage full or disabled: the choice lasts while the page is open. */ }
}
