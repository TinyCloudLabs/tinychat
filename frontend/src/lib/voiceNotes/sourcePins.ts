import { isAutomaticRetryableCode } from "./retryableVoiceNoteErrors";

export const VOICE_NOTE_PENDING_JOBS_KEY = "exo.voiceNotes.privateCloudJobs";
export const VOICE_NOTE_PRIVATE_CHOICES_KEY = "exo.voiceNotes.privateChoices";
const PIN_AGE_KEY = "exo.voiceNotes.privateSourcePinAge";
const PIN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type Source = { owner: string; id: string };
type Release = () => void;
type Waiter = { mode: "shared" | "exclusive"; resolve: (release: Release | null) => void };
type LockState = { name: string; readers: number; writer: boolean; queue: Waiter[] };
const fallbackLocks = new Map<string, LockState>();
const retained = new Map<string, number>();
const extraPinChecks = new Set<(owner: string, id: string) => boolean | Promise<boolean>>();
const sourceKey = ({ owner, id }: Source) => `${owner}\u0000${id}`;
const lockName = ({ owner, id }: Source) => `exo-voice-note-source:${encodeURIComponent(owner)}:${encodeURIComponent(id)}`;

export function accountStorageKey(base: string, accountDid: string): string {
  return `${base}:${accountDid}`;
}

function grant(state: LockState, mode: Waiter["mode"]): Release {
  if (mode === "exclusive") state.writer = true;
  else state.readers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (mode === "exclusive") state.writer = false;
    else state.readers--;
    if (!state.writer && state.readers === 0) {
      if (state.queue.length === 0) fallbackLocks.delete(state.name);
      else pump(state);
    }
  };
}

function pump(state: LockState): void {
  if (state.writer || state.readers > 0 || state.queue.length === 0) return;
  if (state.queue[0]!.mode === "exclusive") {
    const waiter = state.queue.shift()!;
    waiter.resolve(grant(state, "exclusive"));
    return;
  }
  while (state.queue[0]?.mode === "shared") {
    const waiter = state.queue.shift()!;
    waiter.resolve(grant(state, "shared"));
  }
}

function fallbackAcquire(name: string, mode: Waiter["mode"], wait: boolean): Promise<Release | null> {
  let state = fallbackLocks.get(name);
  if (!state) {
    state = { name, readers: 0, writer: false, queue: [] };
    fallbackLocks.set(name, state);
  }
  if (state.queue.length === 0 && !state.writer && (mode === "shared" || state.readers === 0))
    return Promise.resolve(grant(state, mode));
  if (!wait) return Promise.resolve(null);
  return new Promise((resolve) => {
    state!.queue.push({ mode, resolve });
  });
}

function webAcquire(name: string, mode: LockMode, wait: boolean): Promise<Release | null> | null {
  const manager = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!manager) return null;
  return new Promise((resolve, reject) => {
    let unlock: (() => void) | undefined;
    const held = new Promise<void>((done) => { unlock = done; });
    void manager.request(name, { mode, ...(wait ? {} : { ifAvailable: true }) }, async (lock) => {
      if (!lock) { resolve(null); return; }
      resolve(() => unlock?.());
      await held;
    }).catch(reject);
  });
}

type LockMode = "shared" | "exclusive";
async function acquire(source: Source, mode: LockMode, wait: boolean): Promise<Release | null> {
  const name = lockName(source);
  const web = webAcquire(name, mode, wait);
  return web ?? fallbackAcquire(name, mode, wait);
}

export async function withSourceLease<T>(owner: string, id: string, work: () => Promise<T>): Promise<T> {
  const source = { owner, id };
  const release = await acquire(source, "shared", true);
  if (!release) throw new Error("Source lease unavailable");
  const key = sourceKey(source);
  retained.set(key, (retained.get(key) ?? 0) + 1);
  try { return await work(); }
  finally {
    const count = (retained.get(key) ?? 1) - 1;
    if (count === 0) retained.delete(key);
    else retained.set(key, count);
    release();
  }
}

/** Pins a queued or backoff-delayed source in this tab; release exactly once when its work settles. */
export function retainSource(owner: string, id: string): Release {
  const key = sourceKey({ owner, id });
  retained.set(key, (retained.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (retained.get(key) ?? 1) - 1;
    if (count === 0) retained.delete(key);
    else retained.set(key, count);
  };
}

export function registerExtraPins(check: (owner: string, id: string) => boolean | Promise<boolean>): Release {
  extraPinChecks.add(check);
  return () => extraPinChecks.delete(check);
}

function storage(): Storage | undefined {
  try { return globalThis.localStorage; }
  catch { return undefined; }
}

function readJson(storageValue: Storage, key: string): { present: boolean; value: unknown; corrupt: boolean } {
  let raw: string | null;
  try { raw = storageValue.getItem(key); }
  catch { return { present: true, value: null, corrupt: true }; }
  if (raw === null) return { present: false, value: null, corrupt: false };
  try { return { present: true, value: JSON.parse(raw) as unknown, corrupt: false }; }
  catch { return { present: true, value: null, corrupt: true }; }
}

function permanentPinIsCurrent(owner: string, id: string, store: Storage, now: number, signature: string): boolean {
  const key = accountStorageKey(PIN_AGE_KEY, `${encodeURIComponent(owner)}:${encodeURIComponent(id)}`);
  const age = readJson(store, key);
  if (age.corrupt) return true;
  let createdAt: number;
  if (!age.present || (age.value as { signature?: unknown } | null)?.signature !== signature) {
    createdAt = now;
    try {
      const encoded = JSON.stringify({ createdAt, signature });
      store.setItem(key, encoded);
      if (store.getItem(key) !== encoded) return true;
    } catch { return true; }
  } else {
    const record = age.value as { createdAt?: unknown; expired?: unknown } | null;
    if (!record || typeof record !== "object" || !Number.isFinite(record.createdAt)) return true;
    if (record.expired === true) return false;
    createdAt = record.createdAt as number;
  }
  if (now - createdAt < PIN_MAX_AGE_MS) return true;
  try {
    const encoded = JSON.stringify({ createdAt, signature, expired: true });
    store.setItem(key, encoded);
    return store.getItem(key) !== encoded;
  } catch { return true; }
}

function persistedPin(owner: string, id: string, now: number): boolean {
  const store = storage();
  if (!store) return true;
  const pending = readJson(store, accountStorageKey(VOICE_NOTE_PENDING_JOBS_KEY, owner));
  const choices = readJson(store, accountStorageKey(VOICE_NOTE_PRIVATE_CHOICES_KEY, owner));
  if (pending.corrupt || choices.corrupt) return true;
  if (pending.present && (!pending.value || typeof pending.value !== "object" || Array.isArray(pending.value))) return true;
  if (choices.present && (!Array.isArray(choices.value) || choices.value.some((value) => typeof value !== "string"))) return true;
  const all = pending.present ? pending.value as Record<string, unknown> : {};
  const rawJob = all[id];
  if (rawJob !== undefined) {
    if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) return true;
    const job = rawJob as { attemptId?: unknown; transcriptionId?: unknown; held?: unknown; failure?: unknown };
    if (typeof job.attemptId !== "string") return true;
    const remote = typeof job.transcriptionId === "string";
    const failure = typeof job.failure === "string" ? job.failure : null;
    if (remote || (job.held === undefined && failure === null) || isAutomaticRetryableCode(failure)) return true;
    const signature = JSON.stringify({ attemptId: job.attemptId, held: job.held ?? null, failure });
    return permanentPinIsCurrent(owner, id, store, now, signature);
  }
  const hasChoice = choices.present && (choices.value as string[]).includes(id);
  return hasChoice && permanentPinIsCurrent(owner, id, store, now, "choice");
}
export async function isSourcePinned(owner: string, id: string, now = Date.now()): Promise<boolean> {
  const key = sourceKey({ owner, id });
  if ((retained.get(key) ?? 0) > 0 || persistedPin(owner, id, now)) return true;
  try {
    for (const check of extraPinChecks) if (await check(owner, id)) return true;
  } catch {
    // A failed source-dependent pin lookup must not authorize deleting its source.
    return true;
  }
  return false;
}

export async function evictUnlessPinned<T>(
  owner: string,
  id: string,
  stillCurrent: () => boolean,
  evict: () => Promise<T>,
): Promise<{ kind: "evicted"; value: T } | { kind: "in_use" | "pinned" | "account_changed" }> {
  const source = { owner, id };
  const release = await acquire(source, "exclusive", false);
  if (!release) return { kind: "in_use" };
  try {
    if (!stillCurrent()) return { kind: "account_changed" };
    if (await isSourcePinned(owner, id)) return { kind: "pinned" };
    return { kind: "evicted", value: await evict() };
  } finally { release(); }
}

export function __resetSourcePinsForTests(): void {
  fallbackLocks.clear();
  retained.clear();
  extraPinChecks.clear();
}
