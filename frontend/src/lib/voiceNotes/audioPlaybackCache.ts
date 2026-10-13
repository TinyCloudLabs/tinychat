import { logPipeline, logPipelineError } from "@/lib/debugLog";
import { Capacitor } from "@capacitor/core";
import { VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";

type CacheRow = { key: string; blob?: Blob; size: number; playedAt: number };
const DB_NAME = "exo-audio-playback-cache";
const STORE = "audio";
const MB = 1024 * 1024;
export const AUDIO_CACHE_LIMIT = ("__TAURI_INTERNALS__" in globalThis ? 2048 : 500) * MB;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "key" });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("Audio cache database is blocked"));
  });
}

async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

const rows = () => transaction<CacheRow[]>("readonly", (store) => store.getAll());
const read = (key: string) => transaction<CacheRow | undefined>("readonly", (store) => store.get(key));
const write = (row: CacheRow) => transaction<IDBValidKey>("readwrite", (store) => store.put(row));
const remove = (key: string) => transaction<undefined>("readwrite", (store) => store.delete(key));
const remoteKey = (spaceId: string, did: string, source: string, id: string) => JSON.stringify(["space", spaceId, did, source, id]);
const localKey = (id: string) => JSON.stringify(["local", id]);

async function savedRecordings(): Promise<VoiceNoteRecording[]> {
  const notes = (await VoiceNotes.listPending()).recordings.filter((note) =>
    note.ledger?.audio.state === "saved" && (note.options as { uploadAudio?: boolean } | undefined)?.uploadAudio !== false);
  const sizes = await Promise.all(notes.map((note) => VoiceNotes.localAudioSize({ id: note.id })));
  return notes.flatMap((note, index) => sizes[index]!.size > 0 ? [{ ...note, sizeBytes: sizes[index]!.size }] : []);
}

/** A missing local copy is a normal cache miss. Other read errors remain visible. */
export function isMissingLocalAudio(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "not_found" || value?.code === "tombstoned"
    || /^(?:not_found|audio_not_found)$/i.test(value?.message ?? "");
}

export async function localPlaybackUrl(id: string): Promise<string | null> {
  try {
    const result = await VoiceNotes.localAudioUrl({ id });
    await write({ key: localKey(id), size: 0, playedAt: Date.now() })
      .catch((error: unknown) => logPipelineError("audio cache access", error, id));
    logPipeline("audio playback", id, "local", { destination: "device" });
    return Capacitor.convertFileSrc(result.url);
  } catch (error) {
    if (isMissingLocalAudio(error)) return null;
    throw error;
  }
}

let pending: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = pending.then(work, work);
  pending = next.catch(() => undefined);
  return next;
}

/** The caller supplies a complete blob; failed or aborted reads never enter the cache. */
export async function cachedSpaceAudio(
  spaceId: string, did: string, source: string, id: string,
  load: () => Promise<Blob | null>, signal?: AbortSignal,
): Promise<Blob | null> {
  const key = remoteKey(spaceId, did, source, id);
  const existing = await read(key).catch((error: unknown) => {
    logPipelineError("audio cache read", error, id);
    return undefined;
  });
  if (existing?.blob) {
    await write({ ...existing, playedAt: Date.now() })
      .catch((error: unknown) => logPipelineError("audio cache access", error, id));
    logPipeline("audio playback", id, "cache_hit", { destination: "device", bodyBytes: existing.size });
    return existing.blob;
  }
  logPipeline("audio playback", id, "cache_miss", { destination: "space" });
  const blob = await load();
  if (signal?.aborted || !blob) return blob;
  logPipeline("audio playback", id, "space", { destination: "space", bodyBytes: blob.size });
  await exclusive(async () => {
    await write({ key, blob, size: blob.size, playedAt: Date.now() });
    await trimCachedAudio();
  }).catch((error: unknown) => {
    // A full or unavailable device cache must not prevent playback of a complete space read.
    logPipelineError("audio cache write", error, id);
  });
  return blob;
}

export async function cachedAudioSize(): Promise<{ bytes: number; limit: number }> {
  const [entries, notes] = await Promise.all([rows(), savedRecordings()]);
  const remoteBytes = entries.filter((row) => row.blob).reduce((sum, row) => sum + row.size, 0);
  return { bytes: remoteBytes + notes.reduce((sum, note) => sum + note.sizeBytes, 0), limit: AUDIO_CACHE_LIMIT };
}

async function candidates(): Promise<{ key: string; size: number; playedAt: number; id?: string }[]> {
  const [entries, notes] = await Promise.all([rows(), savedRecordings()]);
  const stamps = new Map(entries.map((row) => [row.key, row.playedAt]));
  return [
    ...entries.filter((row) => row.blob).map((row) => ({ key: row.key, size: row.size, playedAt: row.playedAt })),
    ...notes.map((note) => ({ key: localKey(note.id), size: note.sizeBytes,
      playedAt: stamps.get(localKey(note.id)) ?? note.startedAt, id: note.id })),
  ].sort((a, b) => a.playedAt - b.playedAt);
}

async function evict(entry: { key: string; size: number; id?: string }): Promise<void> {
  if (entry.id) {
    // Native and web implementations independently recheck the saved ledger under their storage lock.
    await VoiceNotes.evictCachedAudio({ id: entry.id });
  }
  await remove(entry.key);
  logPipeline("audio playback", entry.id ?? "", "evicted", { destination: "device", bodyBytes: entry.size });
}

export async function trimCachedAudio(limit = AUDIO_CACHE_LIMIT): Promise<void> {
  const all = await candidates();
  let bytes = all.reduce((sum, row) => sum + row.size, 0);
  for (const row of all) {
    if (bytes <= limit) break;
    await evict(row);
    bytes -= row.size;
  }
}

export async function clearCachedAudio(): Promise<void> {
  await exclusive(async () => {
    for (const row of await candidates()) await evict(row);
  });
}
