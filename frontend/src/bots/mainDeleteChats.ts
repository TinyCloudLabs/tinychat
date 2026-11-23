// The owner's "Delete chats" with Main (TC-4080): the service clears Main's conversation and working state first, as
// "Start a new chat" does, and refuses while a reply is in progress or messages are still being saved. Only then is the
// saved history deleted from the owner's space, so a message still on its way to the history is never left behind.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { BotsError, BotsRouteMissing } from "./botsApi";
import { deleteMainHistory } from "./historyDelete";
import { botHistoryEnabled } from "./historyGrant";
import { newMainChat, type NewChatOutcome } from "./mainNewChat";

/**
 * `deleted`: the conversation and the saved history are gone.
 * `busy`, `archive_pending`, `signed_out`, `failed`: nothing was deleted.
 * `history_incomplete`: the conversation is cleared, and some saved history is still there; running it again deletes the rest.
 */
export type DeleteChatsOutcome = "deleted" | "busy" | "archive_pending" | "history_incomplete" | "signed_out" | "failed";

export interface DeleteChatsSteps {
  historyEnabled: () => Promise<boolean>;
  clearConversation: () => Promise<NewChatOutcome>;
  deleteHistory: (tcw: TinyCloudWeb) => Promise<unknown>;
}

const STEPS: DeleteChatsSteps = { historyEnabled: botHistoryEnabled, clearConversation: () => newMainChat(), deleteHistory: deleteMainHistory };

/** Throws BotsRouteMissing when the account has no such route on the service. */
export async function deleteMainChats(tcw: TinyCloudWeb | undefined, steps: DeleteChatsSteps = STEPS): Promise<DeleteChatsOutcome> {
  let saved: boolean;
  let cleared: NewChatOutcome;
  try {
    // Asked before anything is deleted, so a failed answer leaves everything as it was.
    saved = tcw !== undefined && await steps.historyEnabled();
    cleared = await steps.clearConversation();
  } catch (cause) {
    if (cause instanceof BotsRouteMissing) throw cause;
    return cause instanceof BotsError && cause.code === "signed_out" ? "signed_out" : "failed";
  }
  if (cleared !== "cleared") return cleared;
  if (!saved) return "deleted";
  try {
    await steps.deleteHistory(tcw!);
    return "deleted";
  } catch {
    return "history_incomplete";
  }
}
