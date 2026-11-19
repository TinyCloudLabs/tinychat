/**
 * The device's last-known copy of the account's data (feed, chats), so a
 * screen renders from local data at once and the network only refreshes it.
 * One IndexedDB store; values are structured-cloned. Every key starts with the
 * account (`accountCacheKey`), so two accounts on one device never see each
 * other's data. Like the chat-list cache, the copy stays on the device after
 * sign-out.
 *
 * Reads never throw: a missing database (private mode, tests without
 * IndexedDB, a blocked open) reads as "no local copy" and the screen loads from
 * the network as before. Writes are best effort for the same reason.
 */

const DB_NAME = "tinycloud-home-local";
const STORE_NAME = "entries";

interface Row<T> {
  key: string;
  savedAt: number;
  value: T;
}

export interface LocalEntry<T> {
  savedAt: number;
  value: T;
}

let database: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (database) return database;
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  const factory = indexedDB;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the local copy"));
    request.onblocked = () => reject(new Error("Local copy open blocked"));
  });
  database = opening;
  void opening.catch(() => { if (database === opening) database = null; });
  return opening;
}

function run<R>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<R> | void): Promise<R | undefined> {
  return open().then((db) => new Promise<R | undefined>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = body(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => resolve(request ? request.result : undefined);
    transaction.onerror = () => reject(transaction.error ?? new Error("Local copy transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local copy transaction aborted"));
  }));
}

/** `account` is the signed-in DID (or space when no DID is known). */
export function accountCacheKey(account: string, kind: string, id = ""): string {
  return `${account}\u0000${kind}\u0000${id}`;
}

export async function readLocal<T>(key: string): Promise<LocalEntry<T> | null> {
  try {
    const row = await run<Row<T> | undefined>("readonly", (store) => store.get(key) as IDBRequest<Row<T> | undefined>);
    return row ? { savedAt: row.savedAt, value: row.value } : null;
  } catch {
    return null;
  }
}

/** Every entry of one kind for an account, keyed by its id. */
export async function readLocalKind<T>(account: string, kind: string): Promise<Map<string, LocalEntry<T>>> {
  const prefix = accountCacheKey(account, kind);
  try {
    const rows = await run<Row<T>[]>("readonly", (store) =>
      store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`)) as IDBRequest<Row<T>[]>);
    return new Map((rows ?? []).map((row) => [row.key.slice(prefix.length), { savedAt: row.savedAt, value: row.value }]));
  } catch {
    return new Map();
  }
}

export async function writeLocal<T>(key: string, value: T): Promise<void> {
  try {
    await run("readwrite", (store) => { store.put({ key, savedAt: Date.now(), value } satisfies Row<T>); });
  } catch {
    // Best effort: the next successful load writes it again.
  }
}

export async function deleteLocal(key: string): Promise<void> {
  try {
    await run("readwrite", (store) => { store.delete(key); });
  } catch {
    // A stale entry is replaced by the next load.
  }
}

/**
 * Small "this device already did X" flags (a schema created once per
 * account) in localStorage, read synchronously. Unavailable storage reads as
 * "not done", so the work simply runs again.
 */
export function hasLocalMarker(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function setLocalMarker(key: string): void {
  try {
    globalThis.localStorage?.setItem(key, "1");
  } catch {
    // The work runs again next time.
  }
}

export function clearLocalMarker(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Nothing stored.
  }
}

/** Tests only: forget the open handle so a fresh IDBFactory is used. */
export function resetLocalCacheForTests(): void {
  database = null;
}
