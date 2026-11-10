export type AccountSignOutStorage = Pick<Storage, "length" | "key" | "removeItem">;

/** Remove local metadata that belongs only to the account being signed out. */
export function clearAccountSignOutStorage(
  did: string,
  address: string,
  storage: AccountSignOutStorage | undefined = browserStorage(),
): void {
  if (!storage || !did || !address) return;
  const normalizedDid = did.toLowerCase();
  const encodedDid = encodeURIComponent(did).toLowerCase();
  const manifestRevisionPrefix = `xyz.tinycloud.tinychat:manifest-revision:${address.toLowerCase()}`;
  const indexPrefix = `tinychat:index:${normalizedDid}`;

  for (let index = storage.length - 1; index >= 0; index--) {
    let key: string | null;
    try { key = storage.key(index); } catch { continue; }
    if (key === null) continue;
    const normalizedKey = key.toLowerCase();
    const accountExoKey = (normalizedKey.startsWith("exo.") || normalizedKey.startsWith("exo-"))
      && (normalizedKey.includes(normalizedDid) || normalizedKey.includes(encodedDid));
    if (normalizedKey.startsWith(indexPrefix) || normalizedKey.startsWith(manifestRevisionPrefix) || accountExoKey) {
      try { storage.removeItem(key); } catch { /* Keep clearing the remaining account keys. */ }
    }
  }
}

function browserStorage(): AccountSignOutStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}
