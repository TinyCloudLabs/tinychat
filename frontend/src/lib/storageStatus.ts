import { emitStoragePaywallError } from "./chatApi";
import type { TierId } from "./billingApi";

export const MANAGE_STORAGE_URL = "https://account.tinycloud.xyz/billing";
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

const STORAGE_CODES: Record<string, true> = {
  STORAGE_QUOTA_EXCEEDED: true,
  STORAGE_LIMIT_REACHED: true,
};
const STORAGE_TEXT = /STORAGE_QUOTA_EXCEEDED|STORAGE_LIMIT_REACHED|storage quota exceeded|write exceeds remaining storage|storage is full/i;
const TOO_LARGE_TEXT = /STORAGE_LIMIT_REACHED|write exceeds remaining storage/i;
let readOnly = false;
const planListeners = new Set<() => void>();
let freePlan = false;
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


const trackedDatabases = new WeakMap<object, object>();

export function trackStorageWrites<T extends object>(database: T): T {
  const cached = trackedDatabases.get(database);
  if (cached) return cached as T;
  const tracked = new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property !== "execute" && property !== "batch") || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        try {
          const result = await Reflect.apply(value, target, args) as { ok?: boolean; error?: unknown };
          if (result.ok) reportStorageWriteSucceeded();
          else reportStorageError(result.error);
          return result;
        } catch (error) {
          reportStorageError(error);
          throw error;
        }
      };
    },
  });
  trackedDatabases.set(database, tracked);
  return tracked;
}
export function reportStorageError(error: unknown): void {
  if (!isStorageFullError(error)) return;
  storageFullReports++;
  recoveryPending = true;
  if (readOnly) return;
  readOnly = true;
  for (const listener of listeners) listener();
  emitStoragePaywallError(
    storageSaveMessage(error) ?? STORAGE_FULL_SAVE_MESSAGE,
    isTooLargeError(error) ? "STORAGE_LIMIT_REACHED" : "STORAGE_QUOTA_EXCEEDED",
  );
}

let writableEdges = 0;
/**
 * Storage-full work waits for a recovery pass. Every storage-full report sets it, independent of the `readOnly`
 * UI latch. A pass clears it only if it performs a successful write without a new storage-full report; an empty
 * unrelated pass cannot clear another writer's pending recovery.
 */
let recoveryPending = false;
/** Storage-full reports so far. A pass compares this before and after to see whether storage stayed full. */
let storageFullReports = 0;
/** Successful writes so far, used to confirm that a pass actually serviced pending work. */
let successfulStorageWrites = 0;
/** Recovery passes in flight (held-work probe or full pass). A successful write while any is running does not wake another. */
let recoveryPassesInFlight = 0;
let recoveryGeneration = 0;
const recoveryWakeListeners = new Set<() => void>();
const recoveryPassesByKey = new Map<string, number>();
const recoveryKeyWaiters = new Map<string, Set<() => void>>();

function recoveryPassFinished(generation: number, key?: string): void {
  if (generation !== recoveryGeneration) return;
  recoveryPassesInFlight--;
  if (key) {
    const count = (recoveryPassesByKey.get(key) ?? 1) - 1;
    if (count === 0) {
      recoveryPassesByKey.delete(key);
      for (const resolve of recoveryKeyWaiters.get(key) ?? []) resolve();
      recoveryKeyWaiters.delete(key);
    } else recoveryPassesByKey.set(key, count);
  }
}


/** Reset process-wide storage state between tests after their subscriptions are cleaned up. */
export function __resetStorageStatusForTests(): void {
  recoveryGeneration++;
  recoveryPassesInFlight = 0;
  for (const waiters of recoveryKeyWaiters.values()) for (const resolve of waiters) resolve();
  recoveryKeyWaiters.clear();
  recoveryPassesByKey.clear();
  readOnly = false;
  freePlan = false;
  writableEdges = 0;
  recoveryPending = false;
  storageFullReports = 0;
  successfulStorageWrites = 0;
}

/** Wait for the named account's saver pass after a mounted-saver test releases its gates. */
export async function __waitForStorageRecoveryForTests(key: string): Promise<void> {
  while ((recoveryPassesByKey.get(key) ?? 0) !== 0) {
    await new Promise<void>((resolve) => {
      const waiters = recoveryKeyWaiters.get(key) ?? new Set();
      waiters.add(resolve);
      recoveryKeyWaiters.set(key, waiters);
    });
  }
}

export function reportStorageWriteSucceeded(): void {
  successfulStorageWrites++;
  if (readOnly) {
    readOnly = false;
    writableEdges++;
    for (const listener of listeners) listener();
  }
  if (recoveryPending && recoveryPassesInFlight === 0) for (const listener of recoveryWakeListeners) listener();
}

/**
 * Full recovery pass: held work, then reconcile. Pending clears only when the pass completes with no storage-full
 * report, so a pass that re-hits quota leaves it set for the next write.
 */
export async function runStorageRecoveryPass<T>(pass: () => Promise<T>, key?: string): Promise<T> {
  const generation = recoveryGeneration;
  const reportsBefore = storageFullReports;
  const writesBefore = successfulStorageWrites;
  recoveryPassesInFlight++;
  if (key) recoveryPassesByKey.set(key, (recoveryPassesByKey.get(key) ?? 0) + 1);
  let result: T;
  try {
    result = await pass();
  } finally {
    recoveryPassFinished(generation, key);
  }
  if (generation === recoveryGeneration && recoveryPassesInFlight === 0 &&
    storageFullReports === reportsBefore && successfulStorageWrites > writesBefore) recoveryPending = false;
  return result;
}

/** Fires on a successful write while storage-full work is pending and no recovery pass is running. Returns the unsubscribe. */
export function subscribeStorageRecoveryWake(listener: () => void): () => void {
  recoveryWakeListeners.add(listener);
  return () => { recoveryWakeListeners.delete(listener); };
}

/** Count of full→writable edges. An attempt that began before an edge can compare to see whether storage recovered mid-flight. */
export function storageWritableEdgeCount(): number {
  return writableEdges;
}

export function isStorageReadOnly(): boolean {
  return readOnly;
}

export function subscribeStorageReadOnly(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const storageRecoveryWork = new Set<() => Promise<void>>();

/** Held work a foreground recovery pass retries once. Returns the unregister. */
export function registerStorageRecoveryWork(work: () => Promise<void>): () => void {
  storageRecoveryWork.add(work);
  return () => { storageRecoveryWork.delete(work); };
}

/** Probes each registered held item once. A failing item stays held and logs. Does not clear pending on its own. */
export async function runStorageRecoveryWork(): Promise<void> {
  const generation = recoveryGeneration;
  recoveryPassesInFlight++;
  try {
    await Promise.all([...storageRecoveryWork].map((work) =>
      work().catch((error: unknown) => console.warn("[Storage] Could not retry held work", error))));
  } finally {
    recoveryPassFinished(generation);
  }
}

/** Records the signed-in plan from billing status. `null` (unknown) is never treated as Free. */
export function reportStoragePlanTier(tier: TierId | null): void {
  const next = tier === "free";
  if (next === freePlan) return;
  freePlan = next;
  for (const listener of planListeners) listener();
}

export function isFreeStoragePlan(): boolean {
  return freePlan;
}

export function subscribeStoragePlan(listener: () => void): () => void {
  planListeners.add(listener);
  return () => planListeners.delete(listener);
}
