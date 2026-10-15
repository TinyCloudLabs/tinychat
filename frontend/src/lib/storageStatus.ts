import { emitStoragePaywallError } from "./chatApi";
import type { TierId } from "./billingApi";

export const MANAGE_STORAGE_URL = "https://account.tinycloud.xyz/billing?reason=storage-full";
export const STORAGE_FULL_SAVE_MESSAGE =
  "Your TinyCloud storage is full, so this change was not saved. Reading still works.";
export const STORAGE_TOO_LARGE_SAVE_MESSAGE =
  "This change is larger than the TinyCloud storage you have left, so it was not saved. Reading still works.";
export const STORAGE_FULL_RECORDING_LINE =
  "Your TinyCloud storage is full. Your recordings are safe on this device and will upload when space is available.";
/** Only for a transcript that is positively held on this device (native on-device STT with a local transcript). */
export const STORAGE_FULL_TRANSCRIPT_LINE =
  "Your TinyCloud storage is full. Your transcript is kept on this device and will save when space is available.";
/** Private (cloud) transcript refused by full storage. Composed from shared sentences so the variants cannot drift apart. */
const TRANSCRIPT_NOT_SAVED_SENTENCE = "Your TinyCloud storage is full, so this transcript wasn't saved.";
const TRANSCRIBE_AGAIN_SENTENCE = "Transcribe it again when space is available.";
/** No positive evidence of a local copy: the copy makes no claim about the recording. */
export const STORAGE_FULL_TRANSCRIPT_NOT_SAVED_LINE = `${TRANSCRIPT_NOT_SAVED_SENTENCE} ${TRANSCRIBE_AGAIN_SENTENCE}`;
/** Positive evidence the recording is on this device (its ledger local audio is ready). */
export const STORAGE_FULL_TRANSCRIPT_NOT_SAVED_LOCAL_AUDIO_LINE =
  `${TRANSCRIPT_NOT_SAVED_SENTENCE} Your recording is safe on this device. ${TRANSCRIBE_AGAIN_SENTENCE}`;
const STORAGE_DELETION_NOTE =
  "Some deletions may lower your storage usage, but Exo can't yet remove saved voice-note audio, saved uploads or your copies of Transcriber meetings from TinyCloud.";
const STORAGE_NO_LARGER_PLAN = "There's no larger plan to buy.";
/** Detail under the main line on the detailed surfaces. Free sees only the first sentence; paid and unknown get both. */
export const STORAGE_FULL_DETAIL: Record<"free" | "paid", string> = {
  free: STORAGE_DELETION_NOTE,
  paid: `${STORAGE_DELETION_NOTE} ${STORAGE_NO_LARGER_PLAN}`,
};
export const STORAGE_READ_ONLY_NOTICE =
  "Your TinyCloud storage, shared by all your TinyCloud apps, is full. You can still view and copy your data. New changes can't be saved while your storage is full.";

const STORAGE_CODES: Record<string, true> = {
  STORAGE_QUOTA_EXCEEDED: true,
  STORAGE_LIMIT_REACHED: true,
};
const STORAGE_TEXT = /STORAGE_QUOTA_EXCEEDED|STORAGE_LIMIT_REACHED|storage quota exceeded|write exceeds remaining storage|storage is full/i;
const TOO_LARGE_TEXT = /STORAGE_LIMIT_REACHED|write exceeds remaining storage/i;
const planListeners = new Set<() => void>();
const listeners = new Set<() => void>();

const MAX_CAUSE_DEPTH = 4;

/** The error and its causes, outermost first. A string is its own message. */
function errorParts(error: unknown): { code?: unknown; message?: unknown }[] {
  const parts: { code?: unknown; message?: unknown }[] = [];
  let current: unknown = error;
  while (current != null && parts.length < MAX_CAUSE_DEPTH) {
    if (typeof current === "string") {
      parts.push({ message: current });
      break;
    }
    if (typeof current !== "object") break;
    const value = current as { code?: unknown; message?: unknown; cause?: unknown };
    parts.push({ code: value.code, message: value.message });
    current = value.cause;
  }
  return parts;
}

export function isStorageFullError(error: unknown): boolean {
  return errorParts(error).some((part) =>
    (typeof part.code === "string" && STORAGE_CODES[part.code] === true) ||
    (typeof part.message === "string" && STORAGE_TEXT.test(part.message)));
}

function isTooLargeError(error: unknown): boolean {
  return errorParts(error).some((part) =>
    part.code === "STORAGE_LIMIT_REACHED" || (typeof part.message === "string" && TOO_LARGE_TEXT.test(part.message)));
}

export function storageSaveMessage(error: unknown): string | null {
  if (!isStorageFullError(error)) return null;
  return isTooLargeError(error) ? STORAGE_TOO_LARGE_SAVE_MESSAGE : STORAGE_FULL_SAVE_MESSAGE;
}

export interface StorageAccountScope {
  readonly did: string | null;
  readonly spaceId: string | null;
  readonly epoch: number;
  readonly state: StorageStatusState;
}

interface StorageStatusState {
  readOnly: boolean;
  freePlan: boolean;
  writableEdges: number;
  recoveryPending: boolean;
  storageFullReports: number;
  successfulStorageWrites: number;
  recoveryPassesInFlight: number;
  recoveryPassesByKey: Map<string, number>;
  recoveryKeyWaiters: Map<string, Set<() => void>>;
}

function newStorageState(): StorageStatusState {
  return {
    readOnly: false, freePlan: false, writableEdges: 0, recoveryPending: false,
    storageFullReports: 0, successfulStorageWrites: 0, recoveryPassesInFlight: 0,
    recoveryPassesByKey: new Map(), recoveryKeyWaiters: new Map(),
  };
}

let storageEpoch = 0;
let accountSessionManaged = false;
let activeStorageScope: StorageAccountScope = {
  did: null, spaceId: null, epoch: storageEpoch, state: newStorageState(),
};
const clientStorageScopes = new WeakMap<object, StorageAccountScope>();

function isActiveScope(scope: StorageAccountScope | null): scope is StorageAccountScope {
  return scope !== null && scope === activeStorageScope;
}

export function isStorageAccountScopeCurrent(scope: StorageAccountScope | null): scope is StorageAccountScope {
  return isActiveScope(scope);
}

function retireStorageScope(scope: StorageAccountScope): void {
  for (const listener of [...scopeRetiredListeners]) listener(scope);
  for (const entry of [...recoveryWakeListeners]) if (entry.scope === scope) recoveryWakeListeners.delete(entry);
  for (const entry of [...storageRecoveryWork]) if (entry.scope === scope) storageRecoveryWork.delete(entry);
  for (const waiters of scope.state.recoveryKeyWaiters.values()) for (const resolve of waiters) resolve();
  scope.state.recoveryKeyWaiters.clear();
}

/** Resolve the storage epoch captured for a TinyCloud client. Unregistered clients are test-only legacy clients. */
export function storageScopeFor(client: object & { did?: string | null; spaceId?: string | null }): StorageAccountScope | null {
  const registered = clientStorageScopes.get(client);
  if (registered) return registered;
  return accountSessionManaged ? null : activeStorageScope;
}

/** Associate another SDK wrapper for the same session without opening a new epoch. */
export function associateStorageAccountClient(client: object, scope: StorageAccountScope): void {
  clientStorageScopes.set(client, scope);
}

/** Start a fresh storage epoch for a signed-in TinyCloud client. Old completions retain their retired scope. */
export function beginStorageAccountSession(
  client: object, did: string | null, spaceId: string | null,
): StorageAccountScope {
  accountSessionManaged = true;
  retireStorageScope(activeStorageScope);
  const scope: StorageAccountScope = { did, spaceId, epoch: ++storageEpoch, state: newStorageState() };
  activeStorageScope = scope;
  clientStorageScopes.set(client, scope);
  for (const listener of [...listeners]) listener();
  for (const listener of [...planListeners]) listener();
  return scope;
}

/** Retire the current account only after sign-out/handoff has committed. */
export function endStorageAccountSession(): void {
  accountSessionManaged = true;
  retireStorageScope(activeStorageScope);
  activeStorageScope = { did: null, spaceId: null, epoch: ++storageEpoch, state: newStorageState() };
  for (const listener of [...listeners]) listener();
  for (const listener of [...planListeners]) listener();
}

const trackedDatabases = new WeakMap<object, { proxy: object; scope: StorageAccountScope | null }>();

export function trackStorageWrites<T extends object>(
  database: T, scope: StorageAccountScope | null = activeStorageScope,
): T {
  const cached = trackedDatabases.get(database);
  if (cached && cached.scope === scope) return cached.proxy as T;
  const tracked = new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property !== "execute" && property !== "batch") || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        try {
          const result = await Reflect.apply(value, target, args) as { ok?: boolean; error?: unknown };
          if (result.ok) reportStorageWriteSucceeded(scope);
          else reportStorageError(result.error, scope);
          return result;
        } catch (error) {
          reportStorageError(error, scope);
          throw error;
        }
      };
    },
  });
  trackedDatabases.set(database, { proxy: tracked, scope });
  return tracked;
}

export function reportStorageError(error: unknown, scope: StorageAccountScope | null = activeStorageScope): void {
  if (!isStorageFullError(error) || !isActiveScope(scope)) return;
  const state = scope.state;
  state.storageFullReports++;
  state.recoveryPending = true;
  if (state.readOnly) return;
  state.readOnly = true;
  for (const listener of [...listeners]) listener();
  emitStoragePaywallError(
    storageSaveMessage(error) ?? STORAGE_FULL_SAVE_MESSAGE,
    isTooLargeError(error) ? "STORAGE_LIMIT_REACHED" : "STORAGE_QUOTA_EXCEEDED",
  );
}

const recoveryWakeListeners = new Set<{ listener: () => void; scope: StorageAccountScope }>();
const storageRecoveryWork = new Set<{ work: () => Promise<void>; scope: StorageAccountScope }>();
const scopeRetiredListeners = new Set<(scope: StorageAccountScope) => void>();
export function subscribeStorageScopeRetired(listener: (scope: StorageAccountScope) => void): () => void {
  scopeRetiredListeners.add(listener);
  return () => { scopeRetiredListeners.delete(listener); };
}

function recoveryPassFinished(scope: StorageAccountScope, key?: string): void {
  const state = scope.state;
  state.recoveryPassesInFlight--;
  if (key) {
    const count = (state.recoveryPassesByKey.get(key) ?? 1) - 1;
    if (count === 0) {
      state.recoveryPassesByKey.delete(key);
      for (const resolve of state.recoveryKeyWaiters.get(key) ?? []) resolve();
      state.recoveryKeyWaiters.delete(key);
    } else state.recoveryPassesByKey.set(key, count);
  }
}

/** Reset module state between tests; production account transitions use begin/endStorageAccountSession. */
export function __resetStorageStatusForTests(): void {
  retireStorageScope(activeStorageScope);
  accountSessionManaged = false;
  activeStorageScope = {
    did: null, spaceId: null, epoch: ++storageEpoch, state: newStorageState(),
  };
  for (const listener of [...listeners]) listener();
  for (const listener of [...planListeners]) listener();
}

/** Wait for one account's saver pass after a mounted-saver test releases its gates. */
export async function __waitForStorageRecoveryForTests(key: string, scope: StorageAccountScope = activeStorageScope): Promise<void> {
  const state = scope.state;
  while ((state.recoveryPassesByKey.get(key) ?? 0) !== 0) {
    await new Promise<void>((resolve) => {
      const waiters = state.recoveryKeyWaiters.get(key) ?? new Set();
      waiters.add(resolve);
      state.recoveryKeyWaiters.set(key, waiters);
    });
  }
}

export function reportStorageWriteSucceeded(scope: StorageAccountScope | null = activeStorageScope): void {
  if (!isActiveScope(scope)) return;
  const state = scope.state;
  state.successfulStorageWrites++;
  if (state.readOnly) {
    state.readOnly = false;
    state.writableEdges++;
    for (const listener of [...listeners]) listener();
  }
  if (state.recoveryPending && state.recoveryPassesInFlight === 0) {
    for (const entry of [...recoveryWakeListeners]) if (entry.scope === scope) entry.listener();
  }
}

/** Full recovery pass: held work, then reconcile; a stale epoch never clears current-account recovery debt. */
export async function runStorageRecoveryPass<T>(
  pass: () => Promise<T>, key?: string, scope: StorageAccountScope | null = activeStorageScope,
): Promise<T> {
  if (!scope) return pass();
  const state = scope.state;
  const reportsBefore = state.storageFullReports;
  const writesBefore = state.successfulStorageWrites;
  state.recoveryPassesInFlight++;
  if (key) state.recoveryPassesByKey.set(key, (state.recoveryPassesByKey.get(key) ?? 0) + 1);
  try {
    return await pass();
  } finally {
    recoveryPassFinished(scope, key);
    if (isActiveScope(scope) && state.recoveryPassesInFlight === 0 &&
      state.storageFullReports === reportsBefore && state.successfulStorageWrites > writesBefore) {
      state.recoveryPending = false;
    }
  }
}

/** Fires on a successful write while this scope has pending work and no pass is running. */
export function subscribeStorageRecoveryWake(
  listener: () => void, scope: StorageAccountScope | null = activeStorageScope,
): () => void {
  if (!isActiveScope(scope)) return () => {};
  const entry = { listener, scope };
  recoveryWakeListeners.add(entry);
  return () => { recoveryWakeListeners.delete(entry); };
}

export function storageWritableEdgeCount(scope: StorageAccountScope | null = activeStorageScope): number {
  return isActiveScope(scope) ? scope.state.writableEdges : 0;
}

export function isStorageReadOnly(): boolean {
  return activeStorageScope.state.readOnly;
}

export function subscribeStorageReadOnly(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Held work a foreground recovery pass retries once. Returns the unregister. */
export function registerStorageRecoveryWork(
  work: () => Promise<void>, scope: StorageAccountScope | null = activeStorageScope,
): () => void {
  if (!isActiveScope(scope)) return () => {};
  const entry = { work, scope };
  storageRecoveryWork.add(entry);
  return () => { storageRecoveryWork.delete(entry); };
}

/** Probes this account's held items once. Does not clear pending on its own. */
export async function runStorageRecoveryWork(scope: StorageAccountScope | null = activeStorageScope): Promise<void> {
  if (!isActiveScope(scope)) return;
  const state = scope.state;
  state.recoveryPassesInFlight++;
  try {
    await Promise.all([...storageRecoveryWork].filter((entry) => entry.scope === scope).map(({ work }) =>
      work().catch((error: unknown) => console.warn("[Storage] Could not retry held work", error))));
  } finally {
    recoveryPassFinished(scope);
  }
}

/** Records the signed-in plan from billing status. `null` (unknown) is never treated as Free. */
export function reportStoragePlanTier(tier: TierId | null, scope: StorageAccountScope | null = activeStorageScope): void {
  if (!isActiveScope(scope)) return;
  const next = tier === "free";
  const state = scope.state;
  if (next === state.freePlan) return;
  state.freePlan = next;
  for (const listener of [...planListeners]) listener();
}

export function isFreeStoragePlan(): boolean {
  return activeStorageScope.state.freePlan;
}

export function subscribeStoragePlan(listener: () => void): () => void {
  planListeners.add(listener);
  return () => planListeners.delete(listener);
}
