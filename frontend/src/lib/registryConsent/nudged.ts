// Has this owner already been asked, once, to publish their registry record from this device? Written when the prompt
// is shown (shell/FinishSetupNotice.tsx), so Cancel, Escape, a reload or a failed publish never bring it back. It is not
// `dismissed.ts`: that key means "published from this device". Kept in localStorage per owner; another device asks once
// more until the owner publishes, which flips the registry's answer everywhere.
export interface NudgedStore {
  read(subject: string): boolean;
  write(subject: string): void;
}

/** `tinychat.registryNudged.v1.<did:pkh, lowercased>`, so case variants of one owner share a key. The value is `{ "at": ISO time }`; any value that parses as an object counts. */
const nudgedKey = (subject: string) => `tinychat.registryNudged.v1.${subject.toLowerCase()}`;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * When the storage cannot be read the answer is "not asked": the owner is asked again next load rather than never. When
 * it cannot be written, the answer is kept in memory for this page load, so a refused write never asks twice in one load.
 */
export function createNudgedStore(storage: () => StorageLike | undefined = defaultStorage): NudgedStore {
  const askedHere = new Set<string>();
  return {
    read(subject) {
      if (askedHere.has(subject.toLowerCase())) return true;
      try {
        const raw = storage()?.getItem(nudgedKey(subject));
        if (!raw) return false;
        const value: unknown = JSON.parse(raw);
        return typeof value === "object" && value !== null;
      } catch {
        return false;
      }
    },
    write(subject) {
      askedHere.add(subject.toLowerCase());
      try {
        storage()?.setItem(nudgedKey(subject), JSON.stringify({ at: new Date().toISOString() }));
      } catch { /* Kept in memory for this load. */ }
    },
  };
}

function defaultStorage(): StorageLike | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export const registryNudgedStore: NudgedStore = createNudgedStore();
