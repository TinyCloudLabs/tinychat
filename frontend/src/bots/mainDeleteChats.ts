// The owner's "Delete chats" with Main (TC-4080): the service clears Main's conversation and working state first, as
// "Start a new chat" does, and refuses while a reply is in progress or messages are still being saved. Only then is the
// saved history deleted from the owner's space, so a message still on its way to the history is never left behind.
// The saved history is always deleted, whatever the history status says: an account whose status route answers 404 may
// still hold records saved earlier, and an empty listing costs one call.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { BotsError, BotsRouteMissing } from "./botsApi";
import { deleteMainHistory } from "./historyDelete";
import { newMainChat, type NewChatOutcome } from "./mainNewChat";

/**
 * `deleted`: the conversation and the saved history are gone.
 * `busy`, `archive_pending`, `signed_out`, `failed`: nothing was deleted.
 * `history_incomplete`: the conversation is cleared, and some saved history is still there; running it again deletes the rest.
 */
export type DeleteChatsOutcome = "deleted" | "busy" | "archive_pending" | "history_incomplete" | "signed_out" | "failed";

export interface DeleteChatsSteps {
  clearConversation: () => Promise<NewChatOutcome>;
  deleteHistory: (tcw: TinyCloudWeb) => Promise<unknown>;
}

const STEPS: DeleteChatsSteps = { clearConversation: () => newMainChat(), deleteHistory: deleteMainHistory };

/**
 * Without an owner session nothing is deleted, and it says so as `signed_out`: only that session can delete the saved history.
 * Throws BotsRouteMissing when the account has no such route on the service.
 */
export async function deleteMainChats(tcw: TinyCloudWeb | undefined, steps: DeleteChatsSteps = STEPS): Promise<DeleteChatsOutcome> {
  if (!tcw?.session()) return "signed_out";
  let cleared: NewChatOutcome;
  try {
    cleared = await steps.clearConversation();
  } catch (cause) {
    if (cause instanceof BotsRouteMissing) throw cause;
    return cause instanceof BotsError && cause.code === "signed_out" ? "signed_out" : "failed";
  }
  if (cleared !== "cleared") return cleared;
  try {
    await steps.deleteHistory(tcw);
    return "deleted";
  } catch {
    return "history_incomplete";
  }
}
