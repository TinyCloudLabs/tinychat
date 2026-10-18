// This device's cache of the recording settings. A cache belongs to ONE scope: an account (its own localStorage key,
// holding its values and its sync stamp in a single write) or this device (the older shared keys, used while signed
// out and as the one-time source a first account seeds from). Every read and write names its scope, and nothing ever
// copies from one scope's key to another's, so one account's values can never be read for or written to another
// account. localStorage is only a cache; the space document is the source of truth.
import { RECORDING_FIELDS, isValidField, type LocalState, type RecordingField, type SetFields, type SyncedTranscriber } from "./recordingSettings";

export const TRANSCRIBER_KEY = "exo.voiceNotes.transcriber";
export const SPEAKERS_KEY = "exo.voiceNotes.identifySpeakers";
export const UPLOAD_AUDIO_KEY = "exo.voiceNotes.uploadAudio";
export const STOP_AFTER_KEY = "exo.voiceNotes.stopAfter";
export const UPLOAD_ENGINE_KEY = "exo.transcriber.uploadEngine";

/** An account's DID, or null for this device (signed out, or values set before accounts had their own cache). */
export type Scope = string | null;

const accountKey = (account: string) => `exo.voiceNotes.recording:${account}`;

export function localStorageOrNull(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/** What a scope holds: only keys that were explicitly set. The transcriber can be Powerful here; it never syncs. */
export interface Stored {
  transcriber?: string;
  identifySpeakers?: boolean;
  stopAfter?: string;
  uploadAudio?: boolean;
  uploadEngine?: string;
}

// ── Which scope this tab is signed in as ─────────────────────────────────

let signedInAs: Scope = null;

/** The scope live readers and edits use right now: the signed-in account, or the device. Set by sync's attach. */
export function currentScope(): Scope {
  return signedInAs;
}

export function setActiveAccount(account: Scope): void {
  signedInAs = account;
  notifyRecordingSettings();
}

/** Tests only. */
export function __resetActiveAccountForTests(): void {
  signedInAs = null;
}

// ── Notifiers ────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

/** Any change to what this tab shows or records with, from an edit or from sync. */
export function subscribeRecordingSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyRecordingSettings(): void {
  for (const listener of listeners) listener();
}

const editListeners = new Set<(scope: string) => void>();

/** An edit to an account's cache, which that account's space should hear about. Sync's own writes never fire it. */
export function subscribeRecordingEdits(listener: (account: string) => void): () => void {
  editListeners.add(listener);
  return () => { editListeners.delete(listener); };
}

// ── Reading ──────────────────────────────────────────────────────────────

interface AccountRecord { at: number | null; dirty: RecordingField[]; stored: Stored }

const EMPTY: AccountRecord = { at: null, dirty: [], stored: {} };

function readBoolean(raw: string | null): boolean | undefined {
  return raw === "1" ? true : raw === "0" ? false : undefined;
}

function parseAccountRecord(raw: string | null): AccountRecord | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const record = parsed as Record<string, unknown>;
    const stored = typeof record.stored === "object" && record.stored !== null ? record.stored as Record<string, unknown> : {};
    return {
      at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : null,
      dirty: Array.isArray(record.dirty) ? RECORDING_FIELDS.filter((field) => (record.dirty as unknown[]).includes(field)) : [],
      stored: {
        transcriber: typeof stored.transcriber === "string" ? stored.transcriber : undefined,
        identifySpeakers: typeof stored.identifySpeakers === "boolean" ? stored.identifySpeakers : undefined,
        stopAfter: typeof stored.stopAfter === "string" ? stored.stopAfter : undefined,
        uploadAudio: typeof stored.uploadAudio === "boolean" ? stored.uploadAudio : undefined,
        uploadEngine: typeof stored.uploadEngine === "string" ? stored.uploadEngine : undefined,
      },
    };
  } catch { return EMPTY; }
}

function readDevice(store: Storage): Stored {
  return {
    transcriber: store.getItem(TRANSCRIBER_KEY) ?? undefined,
    identifySpeakers: readBoolean(store.getItem(SPEAKERS_KEY)),
    stopAfter: store.getItem(STOP_AFTER_KEY) ?? undefined,
    uploadAudio: readBoolean(store.getItem(UPLOAD_AUDIO_KEY)),
    uploadEngine: store.getItem(UPLOAD_ENGINE_KEY) ?? undefined,
  };
}

function readAccount(store: Storage, account: string): AccountRecord | null {
  return parseAccountRecord(store.getItem(accountKey(account)));
}

/** The explicitly set values of one scope; empty when there is no storage. */
export function readStored(scope: Scope): Stored {
  const store = localStorageOrNull();
  if (!store) return {};
  try { return scope === null ? readDevice(store) : readAccount(store, scope)?.stored ?? {}; } catch { return {}; }
}

/** The sync stamp of an account's cache. The device scope is never synced, so it has none. */
export function readStamp(scope: Scope): { at: number | null; dirty: readonly RecordingField[] } {
  const store = localStorageOrNull();
  if (!store || scope === null) return { at: null, dirty: [] };
  try {
    const record = readAccount(store, scope);
    return { at: record?.at ?? null, dirty: record?.dirty ?? [] };
  } catch { return { at: null, dirty: [] }; }
}

/** One account's cache as the conflict rule sees it: the syncable fields, the stamp, and whether its mode is Powerful. */
export function readLocalState(account: string): LocalState {
  const stored = readStored(account);
  const fields: SetFields = {};
  for (const field of RECORDING_FIELDS) {
    if (isValidField(field, stored[field])) (fields as Record<string, unknown>)[field] = stored[field];
  }
  return { fields, powerful: stored.transcriber === "assemblyai", ...readStamp(account) };
}

// ── Writing: always into the named scope, nowhere else ───────────────────

/** Puts back what a failed save replaced. Returns what could not be restored. */
export interface Snapshot { restore(): string[] }

export function snapshotStored(scope: Scope): Snapshot | null {
  const store = localStorageOrNull();
  if (!store) return null;
  if (scope !== null) {
    const key = accountKey(scope);
    const raw = store.getItem(key);
    return { restore() {
      try { if (raw === null) store.removeItem(key); else store.setItem(key, raw); return []; } catch (failure) {
        console.error(`[VoiceNotes] Could not restore ${key} after a failed save`, failure);
        return ["the saved choice could not be put back"];
      }
    } };
  }
  const prior = [TRANSCRIBER_KEY, SPEAKERS_KEY, UPLOAD_AUDIO_KEY].map((key) => [key, store.getItem(key)] as const);
  return { restore() {
    const problems: string[] = [];
    for (const [key, value] of prior) {
      try { if (value === null) store.removeItem(key); else store.setItem(key, value); } catch (failure) {
        console.error(`[VoiceNotes] Could not restore ${key} after a failed save`, failure);
        problems.push("the saved choice could not be put back");
      }
    }
    return problems;
  } };
}

/**
 * Writes `patch` into `scope`'s cache. An edit to an account's cache stamps itself in the SAME write as its values (so
 * a sync can never see the new value under the old stamp) and then tells sync. The device scope writes its own keys,
 * in order. Throws when storage refuses.
 */
export function writeStored(scope: Scope, patch: Stored, edit?: { fields: readonly RecordingField[]; now?: number }): void {
  const store = localStorageOrNull();
  if (!store) return;
  if (scope === null) {
    if (patch.transcriber !== undefined) store.setItem(TRANSCRIBER_KEY, patch.transcriber);
    if (patch.identifySpeakers !== undefined) store.setItem(SPEAKERS_KEY, patch.identifySpeakers ? "1" : "0");
    if (patch.stopAfter !== undefined) store.setItem(STOP_AFTER_KEY, patch.stopAfter);
    if (patch.uploadAudio !== undefined) store.setItem(UPLOAD_AUDIO_KEY, patch.uploadAudio ? "1" : "0");
    if (patch.uploadEngine !== undefined) store.setItem(UPLOAD_ENGINE_KEY, patch.uploadEngine);
    return;
  }
  const current = readAccount(store, scope) ?? EMPTY;
  const next: AccountRecord = { at: current.at, dirty: current.dirty, stored: { ...current.stored } };
  for (const field of RECORDING_FIELDS) if (patch[field] !== undefined) (next.stored as Record<string, unknown>)[field] = patch[field];
  if (edit) {
    next.at = Math.max(edit.now ?? Date.now(), (current.at ?? 0) + 1);
    next.dirty = RECORDING_FIELDS.filter((field) => current.dirty.includes(field) || edit.fields.includes(field));
  }
  store.setItem(accountKey(scope), JSON.stringify({ v: 1, ...next }));
  if (edit) for (const listener of editListeners) listener(scope);
}

/** After adopting or pushing: this account's cache and its document agree as of `at`. */
export function markSynced(account: string, at: number | null): void {
  const store = localStorageOrNull();
  if (!store) return;
  try {
    const current = readAccount(store, account) ?? EMPTY;
    store.setItem(accountKey(account), JSON.stringify({ v: 1, at, dirty: [], stored: current.stored }));
  } catch { /* Next cycle repeats it. */ }
}

/**
 * An account's first sync: values this device held before accounts had their own cache (or set while signed out) seed
 * the account's cache, once, and are cleared so no later account can take them. The device's values belong to nobody;
 * nothing of any account is ever read from the device scope. A no-op when the account already has a cache.
 */
export function seedFromDevice(account: string): void {
  const store = localStorageOrNull();
  if (!store) return;
  try {
    if (store.getItem(accountKey(account)) !== null) return;
    const device = readDevice(store);
    const explicit = RECORDING_FIELDS.filter((field) => device[field] !== undefined);
    if (explicit.length === 0) return;
    store.setItem(accountKey(account), JSON.stringify({ v: 1, at: null, dirty: [], stored: device }));
    for (const key of [TRANSCRIBER_KEY, SPEAKERS_KEY, UPLOAD_AUDIO_KEY, STOP_AFTER_KEY, UPLOAD_ENGINE_KEY]) store.removeItem(key);
  } catch { /* Next cycle repeats it. */ }
}

/** The mode the signed-in account (or this device) chose; never the untouched default, and never Powerful, which does not sync. */
export function readChosenTranscriber(): SyncedTranscriber | undefined {
  const saved = readStored(currentScope()).transcriber;
  return isValidField("transcriber", saved) ? saved : undefined;
}
