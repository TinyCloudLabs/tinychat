// Earlier (v1) bot history is sealed to the owner's whole encryption network. Opening the chat never asks for that
// grant: a read holds those records back (the chat runs on its own key), and the owner moves them with a separate
// action, which is the only place the network-wide decrypt is requested (TC-4225). This module is what a read needs at
// boot; the action's view (with its strings) and its request load on demand (EarlierHistoryAction.tsx, earlierHistoryRequest.ts).
import { useSyncExternalStore } from "react";
import type { PermissionEntry } from "@tinycloud/web-sdk";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";

/** The permission that opens v1 records: decrypt on the owner's whole encryption network. */
export function earlierHistoryPermissions(address: string, chainId: number): PermissionEntry[] {
  return [{
    service: "tinycloud.encryption",
    path: encryptionNetworkId(address, chainId),
    skipPrefix: true,
    actions: ["decrypt"],
  }];
}

// Which bots' reads held earlier records back, for the owner of this page session. Module state, like the decline.
let heldOwner: string | undefined;
let heldBots = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

/** A read of `bot` found `count` earlier records it could not open (0: none, or all opened). */
export function recordHeldEarlierHistory(owner: string, bot: string, count: number): void {
  const address = owner.toLowerCase();
  if (heldOwner !== address) {
    if (heldBots.size > 0) { heldBots = new Set(); changed(); }
    heldOwner = address;
  }
  if (count > 0 && !heldBots.has(bot)) { heldBots = new Set(heldBots).add(bot); changed(); }
  else if (count === 0 && heldBots.has(bot)) { heldBots = new Set([...heldBots].filter(key => key !== bot)); changed(); }
}

/** Whether the last read of `bot` held earlier records back. */
export const isEarlierHistoryHeld = (bot: string): boolean => heldBots.has(bot);

/** Forgets everything held: at sign-out (App.tsx), so the next account never sees the last one's earlier history. */
export function resetEarlierHistory(): void {
  heldOwner = undefined;
  if (heldBots.size > 0) { heldBots = new Set(); changed(); }
}

/** What a chat view needs to offer moving earlier history: the bot, the request for the grant, and the chat's re-read. */
export interface EarlierHistoryMove {
  bot: string;
  /** Asks the owner for the network-wide decrypt; true when approved (earlierHistoryRequest.ts). */
  request: () => Promise<boolean>;
  /** Reads the chat again, which moves the earlier records with the existing reseal path. */
  reload: () => Promise<void> | void;
}

/** Whether a read of `bot` is holding earlier records back: the action is shown while it is. */
export function useEarlierHistoryHeld(bot: string): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => heldBots.has(bot),
  );
}
