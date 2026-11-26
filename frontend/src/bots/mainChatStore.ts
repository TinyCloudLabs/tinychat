// Main's chat as the page keeps it while the owner is elsewhere in the app. Home's chat is mounted only while the Feed
// is shown, so the lines, the turn in flight and its stream live here, in memory only, for one bots client and one
// signed-in account and space: leaving the Feed neither empties the chat nor cuts a reply the service is still sending.
// Sign-out, another sign-in and a change of account or space drop it and stop its stream. Nothing here is ever stored.
import { subscribeStorageScopeRetired } from "@/lib/storageStatus";
import type { MainChatState } from "./useMainChat";

/** The most lines kept: the oldest go first. */
export const MAX_MAIN_CHAT_LINES = 200;

/** What a mounted view lends the chat. A turn calls the one mounted now, or no one once every view is gone. */
export interface MainChatCallbacks {
  prepare?: () => Promise<void>;
  onNoReply?: () => void;
}

export interface MainChatStore {
  state: MainChatState;
  subscribe: (listener: () => void) => () => void;
  listeners: Set<() => void>;
  consumers: Set<{ current: MainChatCallbacks }>;
  lifetime: AbortController;
  turnController: AbortController | null;
  history: Promise<void> | null;
  historyPending: boolean;
  localId: number;
  queued: (() => void)[];
  /** Counts the owner's new chats, so a history read that started before one never brings the earlier lines back. */
  cleared: number;
  disposed: boolean;
}

const EMPTY: MainChatState = { lines: [], history: "idle", turn: null };

export function createMainChatStore(): MainChatStore {
  const listeners = new Set<() => void>();
  return {
    state: EMPTY,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    listeners, consumers: new Set(), lifetime: new AbortController(), turnController: null,
    history: null, historyPending: false, localId: 0, queued: [], cleared: 0, disposed: false,
  };
}

/** A dropped chat takes no more changes: a turn or read that ends after sign-out writes nothing. */
export function setMainChat(store: MainChatStore, update: (current: MainChatState) => MainChatState): void {
  if (store.disposed) return;
  const next = update(store.state);
  if (next === store.state) return;
  store.state = next.lines.length > MAX_MAIN_CHAT_LINES ? { ...next, lines: next.lines.slice(-MAX_MAIN_CHAT_LINES) } : next;
  for (const listener of store.listeners) listener();
}

/** The mounted view a turn reports to: the latest one, or none. */
export const mountedView = (store: MainChatStore): MainChatCallbacks | undefined => [...store.consumers].at(-1)?.current;

/** Stops the stream, the history read and the decisions waiting to go. */
export function stopMainChat(store: MainChatStore): void {
  store.lifetime.abort();
  store.turnController?.abort();
  store.history = null;
  store.queued = [];
}

function disposeMainChat(store: MainChatStore, notify: boolean): void {
  if (store.disposed) return;
  stopMainChat(store);
  store.consumers.clear();
  store.state = EMPTY;
  store.disposed = true;
  if (notify) for (const listener of store.listeners) listener();
}

// One kept chat per bots client, for the account and space it was kept for.
const kept = new Map<object, { account: string; store: MainChatStore }>();

/**
 * The kept chat for `owner` (the bots client) and `account` (the signed-in DID and space). A chat kept on that client
 * for another account is dropped first and its stream stopped, so its lines never reach this one.
 */
export function mainChatFor(owner: object, account: string): MainChatStore {
  const entry = kept.get(owner);
  if (entry?.account === account) return entry.store;
  // Its views are not told: this runs while a view renders, and that view moves to the new chat itself.
  if (entry) disposeMainChat(entry.store, false);
  const store = createMainChatStore();
  kept.set(owner, { account, store });
  return store;
}

/** Every kept chat goes, and its stream stops. */
export function disposeMainChats(): void {
  for (const { store } of kept.values()) disposeMainChat(store, true);
  kept.clear();
}

// The account's storage session ends at sign-out and is replaced at each sign-in (App.tsx): the kept chats end with it.
// Listening here, not called from App.tsx, keeps this module out of the app's boot bundle.
subscribeStorageScopeRetired(disposeMainChats);
