// Shared bridge between the Feed's AskBox and the mounted Bots view for Main (TrustBot).
// ChatSlot stays mounted across tab switches while FeedView mounts only when on Feed, so the Bots view
// owns the single BotChats store and useAsks poller and publishes Main's live controls here.
// Sign-out or account/space switches clear everything via subscribeStorageScopeRetired.
import { useSyncExternalStore } from "react";

import { subscribeStorageScopeRetired } from "@/lib/storageStatus";
import type { Asks } from "./useAsks";

export interface MainBotBridge {
  account: string;
  working: boolean;
  asks: Asks;
  sendMain(text: string): void;
}

interface PendingMainSend {
  account: string;
  text: string;
}

let current: MainBotBridge | null = null;
let pendingSend: PendingMainSend | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const mainBotBridgeStore = {
  snapshot: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  set(next: MainBotBridge | null) {
    current = next;
    notify();
  },
};

/** Queue a message typed in Feed's AskBox while BotsSurface is still loading; consumed once on mount. */
export function enqueueMainSend(account: string, text: string): void {
  pendingSend = { account: account.toLowerCase(), text };
}

/** Consume any queued Feed message for `account`; returns null if none or for another account. */
export function takePendingMainSend(account: string): string | null {
  if (!pendingSend || pendingSend.account !== account.toLowerCase()) return null;
  const text = pendingSend.text;
  pendingSend = null;
  return text;
}

/** Drop the published bridge and any pending send (sign-out, account switch, or test cleanup). */
export function clearMainBotBridge(): void {
  pendingSend = null;
  if (current === null) return;
  current = null;
  notify();
}

export function useMainBotBridge(account: string | null): MainBotBridge | null {
  const bridge = useSyncExternalStore(mainBotBridgeStore.subscribe, mainBotBridgeStore.snapshot, mainBotBridgeStore.snapshot);
  if (!account || !bridge || bridge.account.toLowerCase() !== account.toLowerCase()) return null;
  return bridge;
}

subscribeStorageScopeRetired(clearMainBotBridge);
