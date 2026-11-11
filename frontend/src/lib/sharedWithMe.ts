import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { THREADS_SQL_DB_NAME } from "./threadKeys";
import { listKvKeys, parseKvValue } from "./shareRecords";

/**
 * The share links a signed-in account has opened or created ("shared with me"),
 * kept in the account's own TinyCloud space so they follow it across devices
 * and origins. localStorage is only this device's fast copy of that list.
 *
 * Remote: one KV entry per share at `SHARED_WITH_ME_KEY_PREFIX + <shareId>`, so
 * two devices writing different shares never overwrite each other. The prefix
 * sits under `threads/` on purpose: the manifest's `tinycloud.kv` `threads/`
 * entry (prefixed to `xyz.tinycloud.tinychat/threads/`, also requested by the
 * native sign-in, TC-2720) already grants get/put/del/list there, so this needs
 * no manifest change.
 *
 * Local: `tinychat:shared-with-me:<did>`, cleared at sign-out with the other
 * account keys (accountSignOutStorage.ts); the space copy is the source of truth.
 *
 * A record holds the share token (the link's secret) and nothing else it does
 * not need. Tokens go only to the account's own space and are never logged.
 */
export const SHARED_WITH_ME_KEY_PREFIX = `${THREADS_SQL_DB_NAME}/shared-with-me/`;
// The browser-only list before the space copy. Folded into the first account
// that signs in on this device, then removed.
export const LEGACY_SHARED_WITH_ME_KEY = "tinychat:shared-with-me:v1";
const LOCAL_KEY_PREFIX = "tinychat:shared-with-me:";

export interface SharedWithMeRecord {
  version: 1;
  /** The share's id, also the KV key suffix. */
  id: string;
  addedAt: string;
  expiresAt: string;
  /** The share token. Absent on a tombstone. */
  token?: string;
  /** Set when the share was removed; the tombstone keeps other devices from re-adding it. */
  removedAt?: string;
}

export type SharedWithMeSpace = Pick<TinyCloudWeb, "did" | "kv">;

interface Binding {
  space: SharedWithMeSpace;
  localKey: string;
}

let binding: Binding | null = null;
// Bumped on every bind; a sync that finishes after a sign-out or account switch is dropped.
let generation = 0;
// Links a viewer opened while no account was bound (signed out, or the session
// still restoring). Kept in memory only; the next account bound in this page
// keeps them, and sign-out forgets them.
let pending = new Map<string, SharedWithMeRecord>();
let version = 0;
const listeners = new Set<() => void>();
let parsedRaw: string | null = null;
let parsedRecords: SharedWithMeRecord[] = [];

export function sharedWithMeLocalKey(did: string): string {
  return `${LOCAL_KEY_PREFIX}${did.toLowerCase()}`;
}

function remoteKey(id: string): string {
  return `${SHARED_WITH_ME_KEY_PREFIX}${encodeURIComponent(id)}`;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseRecord(value: unknown): SharedWithMeRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (r.version !== 1 || typeof r.id !== "string" || !r.id || !isIso(r.addedAt) || !isIso(r.expiresAt)) return null;
  if (r.removedAt !== undefined) {
    return isIso(r.removedAt)
      ? { version: 1, id: r.id, addedAt: r.addedAt, expiresAt: r.expiresAt, removedAt: r.removedAt }
      : null;
  }
  return typeof r.token === "string" && r.token
    ? { version: 1, id: r.id, addedAt: r.addedAt, expiresAt: r.expiresAt, token: r.token }
    : null;
}

function parseRecords(raw: string | null): SharedWithMeRecord[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseRecord).filter((r): r is SharedWithMeRecord => r !== null);
  } catch {
    return [];
  }
}

function toMap(records: Iterable<SharedWithMeRecord>): Map<string, SharedWithMeRecord> {
  return new Map([...records].map((r) => [r.id, r]));
}

function readLocal(localKey: string): Map<string, SharedWithMeRecord> {
  return toMap(parseRecords(storage()?.getItem(localKey) ?? null));
}

function writeLocal(localKey: string, records: Map<string, SharedWithMeRecord>): void {
  try {
    storage()?.setItem(localKey, JSON.stringify([...records.values()]));
  } catch {
    // Best effort: the space copy is the source of truth and the next sync rewrites it.
  }
  notify();
}

/** Union by share id. Last change wins per share (a removal counts at `removedAt`); on a tie a removal wins. */
export function mergeSharedWithMe(
  a: Map<string, SharedWithMeRecord>,
  b: Map<string, SharedWithMeRecord>,
): Map<string, SharedWithMeRecord> {
  const merged = new Map(a);
  for (const [id, record] of b) {
    const current = merged.get(id);
    if (!current) {
      merged.set(id, record);
      continue;
    }
    const diff = Date.parse(record.removedAt ?? record.addedAt) - Date.parse(current.removedAt ?? current.addedAt);
    if (diff > 0 || (diff === 0 && record.removedAt && !current.removedAt)) merged.set(id, record);
  }
  return merged;
}

async function putRemote(space: SharedWithMeSpace, record: SharedWithMeRecord): Promise<void> {
  try {
    await space.kv.put(remoteKey(record.id), JSON.stringify(record));
  } catch {
    // Kept locally; the next sync uploads it.
  }
}

async function readRemote(space: SharedWithMeSpace): Promise<Map<string, SharedWithMeRecord>> {
  const keys = await listKvKeys(space, SHARED_WITH_ME_KEY_PREFIX);
  const records = await Promise.all(keys.map(async (key) => {
    const res = await space.kv.get(key, { source: "network" });
    if (!res.ok) return null;
    const record = parseRecord(parseKvValue(res.data.data));
    // A record is only trusted at its own key.
    return record && remoteKey(record.id) === key ? record : null;
  }));
  return toMap(records.filter((r): r is SharedWithMeRecord => r !== null));
}

/** Legacy browser-only entries, as records. Read once, then the key is removed. */
function takeLegacy(): Map<string, SharedWithMeRecord> {
  const store = storage();
  const raw = store?.getItem(LEGACY_SHARED_WITH_ME_KEY) ?? null;
  if (!store || raw === null) return new Map();
  const records: SharedWithMeRecord[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const r = (item ?? {}) as Record<string, unknown>;
      const record = parseRecord({ version: 1, id: r.id, addedAt: r.acceptedAt, expiresAt: r.expiresAt, token: r.token });
      if (record) records.push(record);
    }
  } catch {
    // Unreadable legacy list: nothing to keep.
  }
  try {
    store.removeItem(LEGACY_SHARED_WITH_ME_KEY);
  } catch {
    // Storage refused the removal; nothing else to do.
  }
  return toMap(records);
}

/**
 * Merges the space copy with this device's copy (union by id, tombstones
 * honoured, expired shares dropped), writes the result locally first, then
 * uploads whatever the space is missing.
 */
async function sync(bound: Binding, gen: number): Promise<void> {
  let remote: Map<string, SharedWithMeRecord>;
  try {
    remote = await readRemote(bound.space);
  } catch {
    return; // Offline or refused: keep the local copy; the next open retries.
  }
  if (gen !== generation) return;
  const now = Date.now();
  const all = mergeSharedWithMe(readLocal(bound.localKey), remote);
  const live = new Map([...all].filter(([, r]) => Date.parse(r.expiresAt) > now));
  writeLocal(bound.localKey, live);
  await Promise.all([...all.values()].map(async (record) => {
    const stored = remote.get(record.id);
    if (!live.has(record.id)) {
      if (stored) await bound.space.kv.delete(remoteKey(record.id)).catch(() => undefined);
    } else if (!stored || JSON.stringify(stored) !== JSON.stringify(record)) {
      await putRemote(bound.space, record);
    }
  }));
}

/**
 * Binds the list to the signed-in account (`space`), or unbinds it (`null`)
 * while the account is not ready (restoring, offline). Binding renders from
 * the local copy at once, folds in the legacy list and links opened while
 * unbound, then syncs with the space. Sign-out uses `signOutSharedWithMe`.
 */
export function bindSharedWithMe(space: SharedWithMeSpace | null): Promise<void> {
  if (binding?.space === space || (!binding && !space)) return Promise.resolve();
  generation += 1;
  if (!space) {
    binding = null;
    notify();
    return Promise.resolve();
  }
  const bound: Binding = { space, localKey: sharedWithMeLocalKey(space.did) };
  binding = bound;
  const carried = mergeSharedWithMe(takeLegacy(), pending);
  pending = new Map();
  writeLocal(bound.localKey, mergeSharedWithMe(readLocal(bound.localKey), carried));
  return sync(bound, generation);
}

/**
 * Sign-out: unbinds, so a sync still in flight cannot write the local copy
 * back, and forgets links opened while unbound, so the next account never
 * receives them.
 */
export function signOutSharedWithMe(): void {
  generation += 1;
  binding = null;
  pending = new Map();
  notify();
}

/** The bound account's records, newest first, tombstones included; empty while signed out. */
export function readSharedWithMe(): SharedWithMeRecord[] {
  if (!binding) return [];
  const raw = storage()?.getItem(binding.localKey) ?? null;
  if (raw !== parsedRaw) {
    parsedRaw = raw;
    parsedRecords = parseRecords(raw).sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
  }
  return parsedRecords;
}

// `account` marks an owner action (create, stop) by that account: it lands only
// in that account's list and is dropped if another account, or none, is bound.
// A viewer opening a link (no `account`) while unbound is held for the next bind.
function record(next: SharedWithMeRecord, account?: string): Promise<void> {
  const bound = binding;
  if (!bound || (account !== undefined && bound.localKey !== sharedWithMeLocalKey(account))) {
    if (!bound && account === undefined) pending.set(next.id, next);
    return Promise.resolve();
  }
  const merged = mergeSharedWithMe(readLocal(bound.localKey), new Map([[next.id, next]]));
  writeLocal(bound.localKey, merged);
  return putRemote(bound.space, merged.get(next.id) ?? next);
}

/** Adds or refreshes a share: local copy now, space copy write-through. */
export function addSharedWithMe(
  entry: { id: string; addedAt: string; expiresAt: string; token: string },
  account?: string,
): Promise<void> {
  return record({ version: 1, ...entry }, account);
}

/**
 * The owner `account` stopped a share: replaces it with a tombstone, locally
 * and in the space; the token is dropped. The tombstone lives until the
 * share's own expiry, after which no device can still hold a live copy to re-add.
 */
export function removeSharedWithMe(id: string, expiresAt: string, account: string): Promise<void> {
  const removedAt = new Date().toISOString();
  const existing = readSharedWithMe().find((r) => r.id === id);
  return record({ version: 1, id, addedAt: existing?.addedAt ?? removedAt, expiresAt, removedAt }, account);
}

export function subscribeSharedWithMe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sharedWithMeVersion(): number {
  return version;
}

/** Tests only. */
export function resetSharedWithMeForTests(): void {
  binding = null;
  generation += 1;
  pending = new Map();
  parsedRaw = null;
  parsedRecords = [];
}
