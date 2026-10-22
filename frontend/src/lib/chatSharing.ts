// While true, no new chat share links can be created. Opening share links
// someone else sent and managing links that already exist are unaffected.
export const CHAT_SHARING_PAUSED = true;

export class ChatSharingPausedError extends Error {
  readonly code = "chat-sharing-paused" as const;

  constructor() {
    super("Chat sharing is paused.");
    this.name = "ChatSharingPausedError";
  }
}

// Whether the Share action may be offered for a chat. While paused, only a chat
// that already has a created link keeps the action, so that link stays copyable.
export function canOfferChatShare(hasExistingShare: boolean): boolean {
  return !CHAT_SHARING_PAUSED || hasExistingShare;
}
