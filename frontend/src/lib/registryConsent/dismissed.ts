// TC-3547: has this owner said "Not now" to publishing their registry record? Kept on this device, per owner, so it
// holds across sign-ins and a different owner is never affected.
//
// The SDK also tries to store the answer, in the account-registry KV at `system/registry-publish/dismissed/v1`. That
// write is ineffective: the sign-in's account-registry grant does not cover that key, so the node refuses it. Until the
// SDK changes, the host is the only place the answer lives, and it never reads the KV. The write below happens when the
// "Not now" button is pressed (broker.ts `declineRegistryConsent`), not on Escape, a tap outside or sign-out.
import { accountStorageKey } from "../voiceNotes/sourcePins";

export interface DismissedStore {
  read(subject: string): boolean;
  write(subject: string): void;
}

const DISMISSED_KEY = "tinychat.registryPublishDismissed";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * Backed by localStorage, keyed by the owner's did:pkh. When the storage cannot be read, the answer is "not dismissed":
 * the owner is asked once more rather than never. When it cannot be written, the answer is kept in memory for this page
 * load, so a refused write never asks again in the same load; the next load asks once more. It never loops.
 */
export function createDismissedStore(storage: () => StorageLike | undefined = defaultStorage): DismissedStore {
  const answeredHere = new Set<string>();
  return {
    read(subject) {
      if (answeredHere.has(subject)) return true;
      try {
        const raw = storage()?.getItem(accountStorageKey(DISMISSED_KEY, subject));
        if (!raw) return false;
        return (JSON.parse(raw) as { dismissed?: unknown } | null)?.dismissed === true;
      } catch {
        return false;
      }
    },
    write(subject) {
      answeredHere.add(subject);
      try {
        storage()?.setItem(accountStorageKey(DISMISSED_KEY, subject), JSON.stringify({ dismissed: true, at: new Date().toISOString() }));
      } catch { /* Kept in memory for this load. */ }
    },
  };
}

function defaultStorage(): StorageLike | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export const registryDismissedStore: DismissedStore = createDismissedStore();
