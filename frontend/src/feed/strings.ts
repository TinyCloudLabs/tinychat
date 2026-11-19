export const FEED_SKILL_URL = "https://agents.tinycloud.xyz/feed";

export const FEED_STRINGS = {
  heading: "Feed",
  subtitle: "Sample cards, so you can see how your feed will look.",
  provenance: "Sample content",
  empty: "Nothing here yet",
  loading: "Loading sample cards…",
  stale: "Couldn't refresh the sample cards. Showing what was loaded before.",
  unavailable: "Couldn't load the sample cards.",
  retry: "Try again",
  openLink: "Open link",
  getStartedHeading: "Get started",
  getStartedBody: "Ask your agent to post to your feed. Its cards show up here.",
  howAgentsPost: "How agents post",
} as const;

/** The note when a link names a card the owner's feed doesn't hold (removed, expired, never posted here, or another account: all look the same). */
export const FEED_CARD_LINK_COPY = {
  missingLead: "That card isn't available.",
  missingRest: "It may have been removed or expired, or it may not be in your feed.",
  dismiss: "Dismiss",
} as const;
