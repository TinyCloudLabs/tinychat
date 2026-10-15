import { logPipeline, logPipelineError } from "@/lib/debugLog";
import { Capacitor } from "@capacitor/core";
import { VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { hasLocalWorkInProgress } from "./localWork";
import { mountedVoiceNoteDid } from "./accountContext";

type CacheRow = { key: string; blob?: Blob; size: number; playedAt: number; identity?: string;
  receipt?: { sha256: string; size: number } | null };
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
const remoteKey = (spaceId: string, did: string, source: string, id: string, identity: string) =>
  JSON.stringify(["space", spaceId, did, source, id, identity]);
const remoteStem = (spaceId: string, did: string, source: string, id: string) =>
  `${JSON.stringify(["space", spaceId, did, source, id]).slice(0, -1)},`;
const localKey = (id: string) => JSON.stringify(["local", id]);
const identityKey = (spaceId: string, did: string, source: string, id: string) =>
  JSON.stringify(["identity", spaceId, did, source, id]);

/** Keep observations independently of cached bytes, including failed downloads and restarts. */
export async function observeSpaceAudioIdentity(
  spaceId: string, did: string, source: string, id: string, identity: string,
  receipt?: { sha256: string; size: number } | null,
): Promise<void> {
  const key = identityKey(spaceId, did, source, id);
  try {
    const previous = await read(key);
    await write({ key, identity, receipt: receipt === undefined && previous?.identity === identity ? previous.receipt : receipt ?? null,
      size: 0, playedAt: Date.now() });
  } catch (error) {
    // A full or unavailable device cache must not prevent playback.
    logPipelineError("audio cache identity write", error, id);
  }
}

/** Undefined means unknown: never observed, or the device cache could not be read. */
export async function latestSpaceAudioIdentity(spaceId: string, did: string, source: string, id: string) {
  try {
    return await read(identityKey(spaceId, did, source, id));
  } catch (error) {
    logPipelineError("audio cache identity read", error, id);
    return undefined;
  }
}

/** The one receipt check: a 64-hex sha256 and a positive safe-integer size. */
export function isVerifiedSpaceReceipt(receipt: { sha256: string; size: number } | null | undefined): receipt is { sha256: string; size: number } {
  return !!receipt && /^[0-9a-f]{64}$/.test(receipt.sha256) && Number.isSafeInteger(receipt.size) && receipt.size > 0;
}

/** Saved, with a verified receipt: the only copy the space is known to hold. Anything else is the phone's own audio. */
export function hasVerifiedSpaceCopy(note: VoiceNoteRecording): boolean {
  return note.ledger?.audio.state === "saved" && isVerifiedSpaceReceipt(note.ledger.audio.verifiedInSpace);
}

async function savedRecordings(): Promise<VoiceNoteRecording[]> {
  // Only the signed-in account's notes are cache candidates. Another account's verified copy is not ours to trim,
  // and with nobody signed in there is no owner to check against, so nothing is a candidate.
  const owner = mountedVoiceNoteDid();
  if (!owner) return [];
  const notes = (await VoiceNotes.listPending()).recordings.filter((note) =>
    note.owner === owner && hasVerifiedSpaceCopy(note) && !hasLocalWorkInProgress(note, { cancelledRetryable: Capacitor.isNativePlatform() }));
  const sizes = await Promise.all(notes.map((note) => VoiceNotes.localAudioSize({ id: note.id })));
  return notes.flatMap((note, index) => sizes[index]!.size === note.ledger!.audio.verifiedInSpace!.size
    ? [{ ...note, sizeBytes: sizes[index]!.size }] : []);
}

/** A missing or still-importing local copy is a normal cache miss. Other read errors remain visible. */
export function isMissingLocalAudio(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "not_found" || value?.code === "tombstoned"
    || value?.code === "audio_preparing" || value?.code === "audio_preparation_failed"
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
  identity: string, load: () => Promise<Blob | null>, signal?: AbortSignal,
  isCurrent?: () => Promise<boolean>,
): Promise<Blob | null> {
  await observeSpaceAudioIdentity(spaceId, did, source, id, identity);
  const key = remoteKey(spaceId, did, source, id, identity);
  const existing = await read(key).catch((error: unknown) => {
    logPipelineError("audio cache read", error, id);
    return undefined;
  });
  if (existing?.blob) {
    await write({ ...existing, playedAt: Date.now() })
      .catch((error: unknown) => logPipelineError("audio cache access", error, id));
    logPipeline("audio playback", id, "cache_hit", { destination: "device", bodyBytes: existing.size });
    void trimCachedAudio().catch((error: unknown) => logPipelineError("audio cache trim", error, id));
    return existing.blob;
  }
  logPipeline("audio playback", id, "cache_miss", { destination: "space" });
  const blob = await load();
  if (signal?.aborted || !blob) return blob;
  if (isCurrent) {
    try { if (!(await isCurrent())) return blob; }
    catch (error) { logPipelineError("audio cache identity check", error, id); return blob; }
  }
  logPipeline("audio playback", id, "space", { destination: "space", bodyBytes: blob.size });
  await exclusive(async () => {
    for (const row of await rows()) {
      if (row.key !== key && (row.key === JSON.stringify(["space", spaceId, did, source, id])
        || row.key.startsWith(remoteStem(spaceId, did, source, id)))) await remove(row.key);
    }
    await write({ key, blob, size: blob.size, playedAt: Date.now() });
    await trimCachedAudioUnlocked();
  }).catch((error: unknown) => {
    // A full or unavailable device cache must not prevent playback of a complete space read.
    logPipelineError("audio cache write", error, id);
  });
  return blob;
}

/** Use the most recently played verified revision when the space cannot be reached. */
export async function cachedSpaceAudioOffline(
  spaceId: string, did: string, source: string, id: string,
): Promise<Blob | null> {
  const latestIdentity = await latestSpaceAudioIdentity(spaceId, did, source, id);
  const all = await rows().catch((error: unknown) => {
    logPipelineError("audio cache read", error, id);
    return [] as CacheRow[];
  });
  const matching = all.filter((row) => row.blob && row.key.startsWith(remoteStem(spaceId, did, source, id))
    && (!latestIdentity?.identity || row.key === remoteKey(spaceId, did, source, id, latestIdentity.identity)))
    .sort((a, b) => b.playedAt - a.playedAt);
  const latest = matching[0];
  if (!latest?.blob) return null;
  await write({ ...latest, playedAt: Date.now() })
    .catch((error: unknown) => logPipelineError("audio cache access", error, id));
  logPipeline("audio playback", id, "offline_cache_hit", { destination: "device", bodyBytes: latest.size });
  return latest.blob;
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

async function evict(entry: { key: string; size: number; id?: string }): Promise<boolean> {
  if (entry.id) {
    // Native and web implementations independently recheck the saved ledger under their storage lock.
    try {
      await VoiceNotes.evictCachedAudio({ id: entry.id });
    } catch (error) {
      // A concurrent write made this note pin its bytes; eviction is optional, so skip it.
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "audio_in_use") return false;
      throw error;
    }
  }
  await remove(entry.key);
  logPipeline("audio playback", entry.id ?? "", "evicted", { destination: "device", bodyBytes: entry.size });
  return true;
}

/**
 * An identity guards cached bytes against replaying a superseded revision. Once a note has no bytes left
 * on this device it guards nothing, and keeping it would report "audio changed" for a plain cache miss.
 */
async function pruneOrphanIdentities(): Promise<void> {
  const [all, { recordings }] = await Promise.all([rows(), VoiceNotes.listPending()]);
  const sizes = await Promise.all(recordings.map((note) => VoiceNotes.localAudioSize({ id: note.id })));
  const local = new Set(recordings.filter((_, index) => sizes[index]!.size > 0).map((note) => note.id));
  const backed = new Set(all.filter((row) => row.blob && row.key.startsWith('["space",'))
    .map((row) => JSON.stringify((JSON.parse(row.key) as string[]).slice(1, 5))));
  for (const row of all) {
    if (!row.key.startsWith('["identity",')) continue;
    const scope = (JSON.parse(row.key) as string[]).slice(1, 5);
    if (local.has(scope[3]!) || backed.has(JSON.stringify(scope))) continue;
    await remove(row.key);
  }
}

async function trimCachedAudioUnlocked(limit = AUDIO_CACHE_LIMIT): Promise<void> {
  const all = await candidates();
  let bytes = all.reduce((sum, row) => sum + row.size, 0);
  let evicted = false;
  for (const row of all) {
    if (bytes <= limit) break;
    if (!(await evict(row))) continue;
    bytes -= row.size;
    evicted = true;
  }
  if (evicted) await pruneOrphanIdentities();
}

export function trimCachedAudio(limit = AUDIO_CACHE_LIMIT): Promise<void> {
  return exclusive(() => trimCachedAudioUnlocked(limit));
}

export async function clearCachedAudio(): Promise<void> {
  await exclusive(async () => {
    for (const row of await candidates()) await evict(row);
    await pruneOrphanIdentities();
  });
}
