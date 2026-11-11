import { bindSharedWithMe, sharedWithMeLocalKey } from "./sharedWithMe";

export type AccountSignOutStorage = Pick<Storage, "length" | "key" | "removeItem">;

/** Remove local metadata that belongs only to the account being signed out. */
export function clearAccountSignOutStorage(
  did: string,
  address: string,
  storage: AccountSignOutStorage | undefined = browserStorage(),
): void {
  // Unbind first so a shared-list sync still in flight cannot write the copy back.
  void bindSharedWithMe(null);
  if (!storage || !did || !address) return;
  const normalizedDid = did.toLowerCase();
  const encodedDid = encodeURIComponent(did).toLowerCase();
  const manifestRevisionPrefix = `xyz.tinycloud.tinychat:manifest-revision:${address.toLowerCase()}`;
  const indexPrefix = `tinychat:index:${normalizedDid}`;
  const memoryPrefix = `tinychat:memory:${normalizedDid}`;
  // This device's copy only; the shared-with-me list itself lives in the account's space.
  const sharedWithMeKey = sharedWithMeLocalKey(did);

  for (let index = storage.length - 1; index >= 0; index--) {
    let key: string | null;
    try { key = storage.key(index); } catch { continue; }
    if (key === null) continue;
    const normalizedKey = key.toLowerCase();
    const accountExoKey = (normalizedKey.startsWith("exo.") || normalizedKey.startsWith("exo-"))
      && (normalizedKey.includes(normalizedDid) || normalizedKey.includes(encodedDid));
    if (normalizedKey.startsWith(indexPrefix) || normalizedKey.startsWith(memoryPrefix)
      || normalizedKey.startsWith(manifestRevisionPrefix) || normalizedKey === sharedWithMeKey || accountExoKey) {
      try { storage.removeItem(key); } catch { /* Keep clearing the remaining account keys. */ }
    }
  }
}

function browserStorage(): AccountSignOutStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}
