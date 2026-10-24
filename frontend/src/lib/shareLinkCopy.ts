// User-facing text for the owner's existing chat share links (Settings card and Share dialog).
export const SHARE_LINK_COPY = {
  listTitle: "Your shared links",
  listDescription: "Links you've shared keep working until they expire.",
  listEmpty: "You have no shared links.",
  loadFailed: "Could not load your shared links.",
  retry: "Try again",
  creationPaused: "New share links can't be created right now.",
  expires: (when: string) => `Expires ${when}`,
  todayAt: (time: string) => `today at ${time}`,
  tomorrowAt: (time: string) => `tomorrow at ${time}`,
} as const;
