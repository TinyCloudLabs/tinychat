// Which `/chat/*` addresses are CHAT VIEWS — the thread / new-chat surface.
//
// Chat-only chrome (the C3 agent access banner) keys off this positive match,
// never off a list of non-chat surfaces: redirects (`/chat/meetings`), unknown
// deep links and any future `/chat/*` page stay excluded without edits here.
//
// There are no per-thread routes: the active thread lives in the assistant
// runtime, not the URL, so the chat view is exactly `/chat`.
//
// Trailing-slash policy: `/chat/` is the same address as `/chat` (both land on
// the chat workspace). No other path gains a trailing-slash alias — so
// `/chat/settings/` or `/chat/connectors/` are never chat views.

export const CHAT_VIEW_PATH = "/chat";

export function isChatViewPath(pathname: string): boolean {
  return pathname === CHAT_VIEW_PATH || pathname === `${CHAT_VIEW_PATH}/`;
}
