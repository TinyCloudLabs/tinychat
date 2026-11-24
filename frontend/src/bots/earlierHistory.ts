// Earlier (v1) bot history is sealed to the owner's whole encryption network. Opening the chat never asks for that
// grant: a read holds those records back (the chat runs on its own key), and the owner moves them with a separate
// action, which is the only place the network-wide decrypt is requested (TC-4225).
import { useCallback, useState, useSyncExternalStore } from "react";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { connectWallet } from "@tinyboilerplate/client";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";
import { EARLIER_HISTORY_STRINGS } from "./botsStrings";
import { ownerPermissionRequester } from "./historyAuthorization";

/** The permission that opens v1 records: decrypt on the owner's whole encryption network. */
export function earlierHistoryPermissions(address: string, chainId: number): PermissionEntry[] {
  return [{
    service: "tinycloud.encryption",
    path: encryptionNetworkId(address, chainId),
    skipPrefix: true,
    actions: ["decrypt"],
    description: EARLIER_HISTORY_STRINGS.approval,
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

/**
 * The owner's request to move earlier history: asks for decrypt on the whole network (the one place it is asked) and
 * resolves with whether it was approved. A decline touches nothing else; the chat's own authorization is separate.
 */
export async function requestEarlierHistoryAccess(tcw: TinyCloudWeb, connect = connectWallet): Promise<boolean> {
  const session = tcw.session();
  if (!session) throw new Error("history_session_missing");
  const permissions = earlierHistoryPermissions(session.address, session.chainId ?? 1);
  if (tcw.hasPermissions(permissions)) return true;
  if (!(await ownerPermissionRequester(tcw, session, connect)(permissions))) return false;
  if (!tcw.hasPermissions(permissions)) throw new Error("history_authority_missing");
  return true;
}

export type EarlierHistoryStatus = "idle" | "moving" | "declined" | "failed";

/** What a chat view needs to offer moving earlier history. Absent: there is nothing held back, or no way to move it. */
export interface EarlierHistory {
  status: EarlierHistoryStatus;
  onMove: () => void;
}

/**
 * The state of the "Move earlier history" action for one bot's chat. `request` asks for the grant; once approved,
 * `reload` reads the chat again, which moves the earlier records with the existing reseal path.
 * Returns undefined when this bot has no earlier history held back (and no move is running).
 */
export function useEarlierHistory(
  bot: string,
  request: (() => Promise<boolean>) | undefined,
  reload: () => Promise<void> | void,
): EarlierHistory | undefined {
  const held = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => heldBots.has(bot),
  );
  const [status, setStatus] = useState<EarlierHistoryStatus>("idle");
  const onMove = useCallback(() => {
    if (!request) return;
    setStatus("moving");
    void (async () => {
      try {
        if (!(await request())) { setStatus("declined"); return; }
        await reload();
        // A chat's read that fails does not reject (the chat shows its own failure row), so what the move achieved is
        // read from the state: if the read held records back again, or never ran, the move did not happen.
        setStatus(heldBots.has(bot) ? "failed" : "idle");
      } catch {
        setStatus("failed");
      }
    })();
  }, [request, reload]);
  return request && (held || status !== "idle") ? { status, onMove } : undefined;
}
