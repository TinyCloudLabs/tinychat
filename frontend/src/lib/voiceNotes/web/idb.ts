// Promise helpers over IndexedDB for the web voice-note store. A write counts as
// durable only when its transaction fires `complete`, never when the request succeeds.

export interface IdbEnv {
  factory: IDBFactory;
  keyRange: typeof IDBKeyRange;
}

export const DB_VERSION = 1;

export const STORES = {
  kv: "kv",
  sessions: "sessions",
  notes: "notes",
  tombstones: "tombstones",
  transcripts: "transcripts",
  receipts: "receipts",
  outbox: "outbox",
  quarantine: "quarantine",
  audioChunks: "audioChunks",
  audioMeta: "audioMeta",
} as const;

export function failure(code: string, message: string = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function browserIdbEnv(): IdbEnv {
  if (typeof indexedDB === "undefined" || typeof IDBKeyRange === "undefined") {
    throw failure("unsupported", "This browser has no IndexedDB, so voice notes cannot be stored.");
  }
  return { factory: indexedDB, keyRange: IDBKeyRange };
}

export function openWebDb(env: IdbEnv, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = env.factory.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore(STORES.kv, { keyPath: "key" });
      db.createObjectStore(STORES.sessions, { keyPath: "id" });
      db.createObjectStore(STORES.notes, { keyPath: "id" });
      db.createObjectStore(STORES.tombstones, { keyPath: "id" });
      db.createObjectStore(STORES.transcripts, { keyPath: "id" });
      db.createObjectStore(STORES.receipts, { keyPath: "key" });
      db.createObjectStore(STORES.outbox, { keyPath: "entryId" });
      db.createObjectStore(STORES.quarantine, { keyPath: "id" });
      db.createObjectStore(STORES.audioChunks, { keyPath: ["id", "offset"] });
      db.createObjectStore(STORES.audioMeta, { keyPath: "id" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(failure("db_blocked", "The voice-note database is open in another tab at an older version."));
  });
}

export function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error);
  });
}

/**
 * Runs `fn` inside one transaction and resolves with its result once the
 * transaction has committed. `fn` may only await IDB requests (anything else
 * lets the transaction auto-commit early). A throw aborts the whole transaction.
 */
export async function transact<T>(
  db: IDBDatabase,
  names: readonly string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const tx = db.transaction([...names], mode, mode === "readwrite" ? { durability: "strict" } : undefined);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? failure("transaction_aborted"));
    tx.onerror = () => reject(tx.error ?? failure("transaction_failed"));
  });
  void done.catch(() => undefined);
  let result: T;
  try {
    result = await fn(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch (abortError) {
      if (!(abortError instanceof DOMException && abortError.name === "InvalidStateError")) throw abortError;
    }
    await done.then(() => undefined, () => undefined);
    throw error;
  }
  await done;
  return result;
}
