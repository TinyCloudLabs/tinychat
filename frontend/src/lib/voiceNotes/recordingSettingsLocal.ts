// This device's cache of the recording settings: the localStorage keys readers use instantly (and offline), the sync
// stamp, and the change notifiers. localStorage is only a cache; the space document is the source of truth.
import { RECORDING_FIELDS, isValidField, type LocalState, type RecordingField, type SetFields } from "./recordingSettings";

export const TRANSCRIBER_KEY = "exo.voiceNotes.transcriber";
export const SPEAKERS_KEY = "exo.voiceNotes.identifySpeakers";
export const UPLOAD_AUDIO_KEY = "exo.voiceNotes.uploadAudio";
export const STOP_AFTER_KEY = "exo.voiceNotes.stopAfter";
export const UPLOAD_ENGINE_KEY = "exo.transcriber.uploadEngine";
const META_KEY = "exo.voiceNotes.recordingSettings.sync";

export function localStorageOrNull(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

const listeners = new Set<() => void>();

/** Any change to what this device shows or records with, from an edit or from sync. */
export function subscribeRecordingSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyRecordingSettings(): void {
  for (const listener of listeners) listener();
}

const editListeners = new Set<() => void>();

/** A change made on this device, which the space should hear about. Sync's own writes never fire it. */
export function subscribeRecordingEdits(listener: () => void): () => void {
  editListeners.add(listener);
  return () => { editListeners.delete(listener); };
}

interface Meta { at: number | null; owner: string | null; dirty: RecordingField[] }

function readMeta(store: Storage): Meta {
  try {
    const parsed: unknown = JSON.parse(store.getItem(META_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return { at: null, owner: null, dirty: [] };
    const record = parsed as Record<string, unknown>;
    return {
      at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : null,
      owner: typeof record.owner === "string" ? record.owner : null,
      dirty: Array.isArray(record.dirty) ? RECORDING_FIELDS.filter((field) => (record.dirty as unknown[]).includes(field)) : [],
    };
  } catch { return { at: null, owner: null, dirty: [] }; }
}

function writeMeta(store: Storage, meta: Meta): void {
  store.setItem(META_KEY, JSON.stringify({ v: 1, ...meta }));
}

function readBoolean(raw: string | null): boolean | undefined {
  return raw === "1" ? true : raw === "0" ? false : undefined;
}

/** Only keys that are present, valid and syncable. An unset key is not a choice and never travels. */
export function readLocalState(): LocalState | null {
  const store = localStorageOrNull();
  if (!store) return null;
  try {
    const raw = {
      transcriber: store.getItem(TRANSCRIBER_KEY) ?? undefined,
      identifySpeakers: readBoolean(store.getItem(SPEAKERS_KEY)),
      stopAfter: store.getItem(STOP_AFTER_KEY) ?? undefined,
      uploadAudio: readBoolean(store.getItem(UPLOAD_AUDIO_KEY)),
      uploadEngine: store.getItem(UPLOAD_ENGINE_KEY) ?? undefined,
    };
    const fields: SetFields = {};
    for (const field of RECORDING_FIELDS) {
      if (isValidField(field, raw[field])) (fields as Record<string, unknown>)[field] = raw[field];
    }
    return { fields, powerful: raw.transcriber === "assemblyai", ...readMeta(store) };
  } catch { return null; }
}

let activeAccount: string | null = null;
// The account this tab was last signed in as. A signed-out edit in this tab belongs to it, whatever another tab did since.
let lastAccount: string | null = null;

/** The signed-in account edits are attributed to; null while signed out. Set by sync's attach. */
export function setActiveAccount(account: string | null): void {
  activeAccount = account;
  if (account !== null) lastAccount = account;
}

/** Tests only: forget which account this tab was signed in as. */
export function __resetAccountsForTests(): void {
  activeAccount = null;
  lastAccount = null;
}

/** After a successful local edit: stamp it newer than anything this device has seen, and tell sync. */
export function markLocalEdit(fields: readonly RecordingField[], now = Date.now()): void {
  const store = localStorageOrNull();
  if (store) {
    try {
      const meta = readMeta(store);
      // A signed-out edit stays attributed to the account that last synced here, so no other account can adopt it.
      writeMeta(store, { at: Math.max(now, (meta.at ?? 0) + 1), owner: activeAccount ?? lastAccount ?? meta.owner,
        dirty: RECORDING_FIELDS.filter((field) => meta.dirty.includes(field) || fields.includes(field)) });
    } catch { /* This session only; the edit still shows. */ }
  }
  for (const listener of editListeners) listener();
}

/** After adopting or pushing: this device and the document agree as of `at`, for `owner`. */
export function markSynced(at: number | null, owner: string): void {
  const store = localStorageOrNull();
  if (!store) return;
  try { writeMeta(store, { at, owner, dirty: [] }); } catch { /* Next cycle repeats it. */ }
}

/**
 * The cache is this account's from now on, keeping its values and pending edits. Values another account left in it are
 * dropped first. True when they were: callers then refresh what is derived from the cache (the capture engine's copy).
 */
export function takeCacheFor(account: string): boolean {
  const store = localStorageOrNull();
  if (!store) return false;
  try {
    const meta = readMeta(store);
    const foreign = meta.owner !== null && meta.owner !== account;
    if (foreign) dropSyncedKeys();
    if (foreign || meta.owner !== account) writeMeta(store, foreign ? { at: null, owner: account, dirty: [] } : { ...meta, owner: account });
    return foreign;
  } catch { return false; }
}

/** Before an edit writes its key: another tab may have handed this cache to a different account since this tab last looked. */
export function takeActiveCache(): boolean {
  const account = activeAccount ?? lastAccount;
  return account === null ? false : takeCacheFor(account);
}

/** Forgets every synced value and the stamp: another account's choices must not outlive its session on this device. */
export function dropSyncedKeys(): void {
  const store = localStorageOrNull();
  if (!store) return;
  for (const key of [TRANSCRIBER_KEY, SPEAKERS_KEY, UPLOAD_AUDIO_KEY, STOP_AFTER_KEY, UPLOAD_ENGINE_KEY, META_KEY]) {
    try { store.removeItem(key); } catch { /* Next cycle repeats it. */ }
  }
}
