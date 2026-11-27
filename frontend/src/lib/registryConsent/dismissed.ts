// TC-3547: was this owner's registry record published from this device? Written only when the SDK answers "published" or
// "already-current" (intent.ts), kept in localStorage per owner, so the finish-setup card stays hidden for that account on
// this device across page loads, sign-ins and sign-outs. A refused signature, "unavailable", "needs-one" or a thrown
// error writes nothing. A different owner is never affected, and another device shows the card once more. The SDK has no
// such flag; this one is the host's.
export interface DismissedStore {
  read(subject: string): boolean;
  write(subject: string): void;
  /** Calls `listener` after every write, so a mounted card can hide at once. Returns the way to stop listening. */
  subscribe(listener: () => void): () => void;
}

/** `tcw.tc3547.dismissed.<did:pkh, lowercased>`, so case variants of one owner share a key. The value is `{ "dismissed": true, "at": ISO time }`; any value whose `dismissed` is `true` counts. */
const dismissedKey = (subject: string) => `tcw.tc3547.dismissed.${subject.toLowerCase()}`;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * Backed by localStorage, keyed by the owner's did:pkh. When the storage cannot be read, the answer is "not dismissed":
 * the card shows rather than hiding for good. When it cannot be written, the answer is kept in memory for this page
 * load, so a refused write never brings the card back in the same load; the next load shows it once more.
 */
export function createDismissedStore(storage: () => StorageLike | undefined = defaultStorage): DismissedStore {
  const answeredHere = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    read(subject) {
      if (answeredHere.has(subject)) return true;
      try {
        const raw = storage()?.getItem(dismissedKey(subject));
        if (!raw) return false;
        return (JSON.parse(raw) as { dismissed?: unknown } | null)?.dismissed === true;
      } catch {
        return false;
      }
    },
    write(subject) {
      answeredHere.add(subject);
      try {
        storage()?.setItem(dismissedKey(subject), JSON.stringify({ dismissed: true, at: new Date().toISOString() }));
      } catch { /* Kept in memory for this load. */ }
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function defaultStorage(): StorageLike | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export const registryDismissedStore: DismissedStore = createDismissedStore();
