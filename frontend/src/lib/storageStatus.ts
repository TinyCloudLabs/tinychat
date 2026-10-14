import { emitStoragePaywallError } from "./chatApi";
import type { TierId } from "./billingApi";

export const MANAGE_STORAGE_URL = "https://account.tinycloud.xyz/billing";
export const STORAGE_FULL_SAVE_MESSAGE =
  "Your TinyCloud storage is full, so this change was not saved. Reading still works.";
export const STORAGE_TOO_LARGE_SAVE_MESSAGE =
  "This change is larger than the TinyCloud storage you have left, so it was not saved. Reading still works.";
export const STORAGE_READ_ONLY_NOTICE =
  "Your TinyCloud storage, shared by all your TinyCloud apps, is full. You can still view and copy your data. Saving changes is paused until more storage is available.";
export const STORAGE_FULL_RECORDING_LINE =
  "Your TinyCloud storage is full. Your recordings are safe on this device and will upload when space is available.";
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
const STORAGE_TEXT = /storage quota exceeded|write exceeds remaining storage|storage is full/i;
const TOO_LARGE_TEXT = /write exceeds remaining storage/i;
let readOnly = false;
const planListeners = new Set<() => void>();
let freePlan = false;
const listeners = new Set<() => void>();

function parts(error: unknown): { code?: unknown; message?: unknown } {
  if (typeof error === "string") return { message: error };
  if (!error || typeof error !== "object") return {};
  const value = error as { code?: unknown; message?: unknown; cause?: unknown };
  const cause = value.cause && typeof value.cause === "object"
    ? value.cause as { code?: unknown; message?: unknown }
    : {};
  return { code: value.code ?? cause.code, message: value.message ?? cause.message };
}

export function isStorageFullError(error: unknown): boolean {
  const { code, message } = parts(error);
  return (typeof code === "string" && STORAGE_CODES[code] === true) ||
    (typeof message === "string" && STORAGE_TEXT.test(message));
}

export function storageSaveMessage(error: unknown): string | null {
  if (!isStorageFullError(error)) return null;
  const { code, message } = parts(error);
  return code === "STORAGE_LIMIT_REACHED" || (typeof message === "string" && TOO_LARGE_TEXT.test(message))
    ? STORAGE_TOO_LARGE_SAVE_MESSAGE
    : STORAGE_FULL_SAVE_MESSAGE;
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
  if (!isStorageFullError(error) || readOnly) return;
  readOnly = true;
  for (const listener of listeners) listener();
  const { code, message } = parts(error);
  emitStoragePaywallError(
    storageSaveMessage(error) ?? STORAGE_FULL_SAVE_MESSAGE,
    code === "STORAGE_LIMIT_REACHED" || (typeof message === "string" && TOO_LARGE_TEXT.test(message))
      ? "STORAGE_LIMIT_REACHED"
      : "STORAGE_QUOTA_EXCEEDED",
  );
}

export function reportStorageWriteSucceeded(): void {
  if (!readOnly) return;
  readOnly = false;
  for (const listener of listeners) listener();
}

export function isStorageReadOnly(): boolean {
  return readOnly;
}

export function subscribeStorageReadOnly(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
