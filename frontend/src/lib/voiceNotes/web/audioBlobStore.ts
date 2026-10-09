import { failure, request, STORES, transact, type IdbEnv } from "./idb";

/**
 * Where a recording's bytes live. webStore never assumes IndexedDB: the Tauri
 * build supplies an implementation backed by files on disk (TC-880).
 *
 * Reconcile rule for every implementation. The blob store's `size()` is the truth
 * about what is durable; the session journal (bytes, audioMs) only describes it.
 * When a store cannot append and journal in one transaction (`transactional` is
 * absent), the journal write can fail, or the tab can die, after `append` resolved.
 * Then webStore trusts `size()`: it never deletes durable bytes, it commits the
 * recording at the size the store reports, and it re-derives the duration from it
 * (journaled audioMs scaled by size / journaled bytes, or the decoded duration when
 * the journal never saw a byte). A journal failure is surfaced, never swallowed.
 */
export interface AudioBlobStore {
  /**
   * Set only when the audio shares the session journal's IndexedDB database. webStore
   * then appends inside the journal's own transaction, so a chunk's bytes and the
   * session's progress become durable together or not at all.
   */
  readonly transactional?: {
    /** Every object store `appendIn` writes. */
    readonly stores: readonly string[];
    appendIn(tx: IDBTransaction, id: string, chunk: Uint8Array): Promise<number>;
  };
  /** Appends to the end of the recording's bytes; resolves with the new total size once durable. */
  append(id: string, chunk: Uint8Array): Promise<number>;
  /** Bytes stored so far (0 when nothing was ever appended). */
  size(id: string): Promise<number>;
  /** Exactly min(length, size - offset) bytes from `offset`; empty at or past the end. */
  read(id: string, offset: number, length: number): Promise<Uint8Array>;
  /** Seals the recording (no more appends) and resolves with its final size. */
  finalize(id: string): Promise<number>;
  /** Removes every byte of the recording; a missing recording is not an error. */
  delete(id: string): Promise<void>;
}

interface ChunkRow { id: string; offset: number; bytes: ArrayBuffer }
interface MetaRow { id: string; size: number; finalized: boolean }

export function createIdbAudioBlobStore(db: IDBDatabase, env: IdbEnv): AudioBlobStore {
  const names = [STORES.audioChunks, STORES.audioMeta];
  const appendIn = async (tx: IDBTransaction, id: string, chunk: Uint8Array): Promise<number> => {
    const meta = (await request(tx.objectStore(STORES.audioMeta).get(id)) as MetaRow | undefined) ?? { id, size: 0, finalized: false };
    if (meta.finalized) throw failure("audio_finalized", `Recording ${id} is sealed.`);
    if (chunk.byteLength === 0) return meta.size;
    const row: ChunkRow = { id, offset: meta.size, bytes: chunk.slice().buffer };
    tx.objectStore(STORES.audioChunks).put(row);
    const size = meta.size + chunk.byteLength;
    tx.objectStore(STORES.audioMeta).put({ id, size, finalized: false } satisfies MetaRow);
    return size;
  };
  return {
    transactional: { stores: names, appendIn },
    append: (id, chunk) => transact(db, names, "readwrite", (tx) => appendIn(tx, id, chunk)),

    size: (id) =>
      transact(db, [STORES.audioMeta], "readonly", async (tx) =>
        ((await request(tx.objectStore(STORES.audioMeta).get(id)) as MetaRow | undefined)?.size ?? 0)),

    read: (id, offset, length) =>
      transact(db, names, "readonly", async (tx) => {
        const meta = (await request(tx.objectStore(STORES.audioMeta).get(id)) as MetaRow | undefined);
        const size = meta?.size ?? 0;
        const want = Math.max(0, Math.min(length, size - offset));
        const out = new Uint8Array(want);
        if (want === 0) return out;
        const chunks = tx.objectStore(STORES.audioChunks);
        // The chunk holding `offset` is the last one starting at or before it.
        const first = await new Promise<ChunkRow | null>((resolve, reject) => {
          const cursor = chunks.openCursor(env.keyRange.bound([id, 0], [id, offset]), "prev");
          cursor.onsuccess = () => resolve(cursor.result ? (cursor.result.value as ChunkRow) : null);
          cursor.onerror = () => reject(cursor.error);
        });
        if (!first) throw failure("audio_corrupt", `Recording ${id} has no bytes at ${offset}.`);
        let filled = 0;
        await new Promise<void>((resolve, reject) => {
          const cursor = chunks.openCursor(env.keyRange.bound([id, first.offset], [id, size], false, true));
          cursor.onsuccess = () => {
            const at = cursor.result;
            if (!at) return resolve();
            const row = at.value as ChunkRow;
            const bytes = new Uint8Array(row.bytes);
            const from = Math.max(0, offset - row.offset);
            const part = bytes.subarray(from, Math.min(bytes.byteLength, from + (want - filled)));
            out.set(part, filled);
            filled += part.byteLength;
            if (filled >= want) return resolve();
            at.continue();
          };
          cursor.onerror = () => reject(cursor.error);
        });
        if (filled !== want) throw failure("audio_corrupt", `Recording ${id} is missing bytes (${filled} of ${want} at ${offset}).`);
        return out;
      }),

    finalize: (id) =>
      transact(db, [STORES.audioMeta], "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.audioMeta);
        const meta = (await request(store.get(id)) as MetaRow | undefined) ?? { id, size: 0, finalized: false };
        store.put({ ...meta, finalized: true } satisfies MetaRow);
        return meta.size;
      }),

    delete: (id) =>
      transact(db, names, "readwrite", async (tx) => {
        tx.objectStore(STORES.audioChunks).delete(env.keyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
        tx.objectStore(STORES.audioMeta).delete(id);
      }),
  };
}
