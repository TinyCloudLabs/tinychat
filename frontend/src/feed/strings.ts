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

/** Settings → card.md: the owner's note on how agents make cards for their Feed. `{version}` and `{time}` are filled in. */
export const CARD_MD_STRINGS = {
  title: "card.md",
  note: "How agents make cards for your Feed. Every agent reads it before it starts posting, and sees a new version the next time it posts.",
  label: "card.md text",
  loading: "Loading…",
  loadFailed: "Couldn't load card.md.",
  retry: "Try again",
  save: "Save",
  saving: "Saving…",
  saveFailed: "Couldn't save card.md. Try again.",
  reset: "Reset to default",
  unsaved: "Not saved",
  version: "Version {version}, saved {time}",
  emptyNote: "It's empty, so agents get no instructions from your Feed.",
} as const;
