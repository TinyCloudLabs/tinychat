// What the navigation shows of the Bots view (TC-3325): the account's bots under Chat in the sidebar and on the
// rail, and the New bot row. The Chat slot (ChatSlot.tsx) publishes it while the Bots view is mounted and clears it
// when it goes, so the sidebar and the rail show nothing extra with the classic chat. The same pattern as
// sidebarActivityStore: one shell per page, so one value.
import { useSyncExternalStore, type ComponentProps } from "react";

import type { BotAvatar } from "./BotAvatar";
import type { BotChats } from "./useBotChat";

export interface NavBot {
  key: string;
  name: string;
  face: ComponentProps<typeof BotAvatar>["bot"];
}

export interface BotsNavState {
  /** Main first, then oldest first; bots being deleted are left out. */
  bots: readonly NavBot[];
  /** The bot the Chat slot shows. */
  selected: string;
  /** The Chat slot is on screen (the selected bot's row is then the current page). */
  chatShown: boolean;
  /** Each bot's conversation, for the working ring and the new-reply dot; null for the first render. */
  chats: BotChats | null;
  newBot: {
    /** False at the cap, or while the list is loading or failed. */
    enabled: boolean;
    /** "<n> of <max> bots", when the backend gave numbers. */
    counter: string | null;
    /** Why New bot is off at the cap. */
    reason: string | null;
    open: () => void;
  };
}

let state: BotsNavState | null = null;
const listeners = new Set<() => void>();

export const botsNavStore = {
  snapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  set(next: BotsNavState | null) {
    state = next;
    for (const listener of listeners) listener();
  },
};

export function useBotsNav(): BotsNavState | null {
  return useSyncExternalStore(botsNavStore.subscribe, botsNavStore.snapshot, botsNavStore.snapshot);
}
