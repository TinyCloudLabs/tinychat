/** Last visible save problem for a locally retained note. The native ledger
 * owns the recording; this small IndexedDB record survives a WebView restart. */
export interface PendingSaveState {
  id: string;
  failed?: { kind: "offline" | "rejected" | "timeout" | "quota" | "auth" | "server" | "source" | "other"; message: string };
  held?: "signed-out" | "other-account" | "legacy" | "unowned";
  retryAt?: number;
}

const DB_NAME = "exo-pending-save-state";
const STORE_NAME = "notes";
const memory = new Map<string, PendingSaveState>();
const writes = new Map<string, Promise<void>>();
let database: Promise<IDBDatabase> | null = null;
const keyFor = (did: string | null, id: string) => JSON.stringify([did, id]);

function open(): Promise<IDBDatabase> {
  if (database) return database;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open pending save state"));
  });
  database = opening;
  void opening.catch(() => { if (database === opening) database = null; });
  return opening;
}

export function putPendingSaveState(did: string | null, state: PendingSaveState): Promise<void> {
  const key = keyFor(did, state.id);
  const previous = writes.get(key) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    if (typeof indexedDB === "undefined") {
      if (state.failed || state.held || state.retryAt) memory.set(key, state);
      else memory.delete(key);
      return;
    }
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
      const store = transaction.objectStore(STORE_NAME);
      if (state.failed || state.held || state.retryAt) store.put({ ...state, key });
      else store.delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save pending status"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Pending status write aborted"));
    });
  });
  writes.set(key, write);
  void write.finally(() => { if (writes.get(key) === write) writes.delete(key); }).catch(() => undefined);
  return write;
}

export async function readPendingSaveStates(did: string | null, ids: readonly string[]): Promise<Map<string, PendingSaveState>> {
  if (ids.length === 0) return new Map();
  await Promise.all(ids.map((id) => writes.get(keyFor(did, id))?.catch(() => undefined)));
  if (typeof indexedDB === "undefined") {
    return new Map(ids.flatMap((id) => {
      const state = memory.get(keyFor(did, id));
      return state ? [[id, state] as const] : [];
    }));
  }
  const db = await open();
  return new Promise((resolve, reject) => {
    const result = new Map<string, PendingSaveState>();
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    for (const id of ids) {
      const request = store.get(keyFor(did, id));
      request.onsuccess = () => {
        if (request.result) {
          const { key: _key, ...state } = request.result as PendingSaveState & { key: string };
          result.set(id, state);
        }
      };
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not read pending save state"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Pending status read aborted"));
  });
}
