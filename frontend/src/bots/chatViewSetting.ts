// Which view the Chat slot shows (TC-3325): Classic, the chat as it has been, or Bots, one chat per bot. Kept in
// this device's storage per account, like the feed's view mode (feed/feedViewMode.ts) but keyed by the account's
// DID, so another account on the same device starts from the default. Bots shows only for an account the backend
// lets use bots; for any other the slot shows Classic whatever is saved.
import { useCallback, useEffect, useState } from "react";

export type ChatView = "classic" | "bots";

/** The view an account has until it picks one. */
export const DEFAULT_CHAT_VIEW: ChatView = "classic";

export const CHAT_VIEW_KEY_PREFIX = "tinychat:chat-view:v1:";
const CHANGE_EVENT = "tinychat:chat-view";

const keyFor = (account: string) => `${CHAT_VIEW_KEY_PREFIX}${account.toLowerCase()}`;

/** The account's explicitly saved choice, or null when it has never picked one (or storage is unavailable). */
export function readSavedChatView(account: string): ChatView | null {
  try {
    const saved = window.localStorage.getItem(keyFor(account));
    return saved === "classic" || saved === "bots" ? saved : null;
  } catch {
    return null;
  }
}

/** The account's saved choice, or the default when nothing, something unknown, or no storage is there. */
export function readChatView(account: string): ChatView {
  return readSavedChatView(account) ?? DEFAULT_CHAT_VIEW;
}

export function saveChatView(account: string, view: ChatView): void {
  try {
    window.localStorage.setItem(keyFor(account), view);
  } catch { /* localStorage full or disabled: the choice lasts while the page is open. */ }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { account: account.toLowerCase(), view } }));
}

/** The account's explicitly saved choice (null if unset), following changes made elsewhere in the page and other tabs. */
export function useSavedChatView(account: string | null): [ChatView | null, (view: ChatView) => void] {
  const [saved, setSaved] = useState<{ account: string | null; view: ChatView | null }>(() => ({
    account,
    view: account ? readSavedChatView(account) : null,
  }));
  useEffect(() => {
    if (!account) return;
    const refresh = () => setSaved({ account, view: readSavedChatView(account) });
    const changed = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      if (detail && typeof detail === "object" && "account" in detail && "view" in detail
        && detail.account === account.toLowerCase() && (detail.view === "classic" || detail.view === "bots")) {
        setSaved({ account, view: detail.view });
      }
    };
    refresh();
    window.addEventListener(CHANGE_EVENT, changed);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CHANGE_EVENT, changed);
      window.removeEventListener("storage", refresh);
    };
  }, [account]);
  const set = useCallback((view: ChatView) => {
    if (account) saveChatView(account, view);
  }, [account]);
  const view = saved.account === account ? saved.view : account ? readSavedChatView(account) : null;
  return [view, set];
}

/** The account's view, following changes made elsewhere in this page and in other tabs. Null account: the default. */
export function useChatView(account: string | null): [ChatView, (view: ChatView) => void] {
  const [saved, set] = useSavedChatView(account);
  return [saved ?? DEFAULT_CHAT_VIEW, set];
}
