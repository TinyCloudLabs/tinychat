// A fake of the SDK surface TC-3547 touches: `ensureOwnerRegistryRecord()` takes no arguments and answers one of the
// four outcomes the SDK documents.
import type { RegistryPublishClient, RegistryPublishOutcome } from "./adapter";
import { createDismissedStore, type DismissedStore } from "./dismissed";

/** A localStorage stand-in, so a test never touches the shared default store. */
export function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}
export function memoryDismissedStore(): DismissedStore {
  const storage = memoryStorage();
  return createDismissedStore(() => storage);
}

export const OWNER_DID = "did:pkh:eip155:1:0x00000000000000000000000000000000000abcd1";

export function fakeSdk(outcome: RegistryPublishOutcome = "published") {
  const calls: unknown[][] = [];
  const log: string[] = [];
  const client = {
    did: OWNER_DID,
    async ensureOwnerRegistryRecord(...args: unknown[]): Promise<RegistryPublishOutcome> {
      calls.push(args);
      log.push("ensure");
      return outcome;
    },
  } satisfies RegistryPublishClient;
  return { client, calls, log };
}
