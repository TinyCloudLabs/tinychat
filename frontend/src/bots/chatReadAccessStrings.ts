// Monica, TC-4058. Per-chat read access in Feed and chats settings.
export const CHAT_READ_ACCESS_STRINGS = {
  heading: "Chats TrustBot can read",
  description: "TrustBot can read the chats switched on here when it answers you or your paired agents. Switch a chat off to keep it out.",
  switchLabel: "TrustBot can read this chat",
  empty: "No chats to show.",
  loading: "Loading chats…",
  loadError: "Your chats couldn't be loaded. Try again.",
  saveError: "This change wasn't saved. Try again.",
  unnamed: "Untitled chat",
} as const;
