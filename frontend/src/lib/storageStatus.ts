import { emitStoragePaywallError } from "./chatApi";
import type { TierId } from "./billingApi";

export const MANAGE_STORAGE_URL = "https://account.tinycloud.xyz/billing";
export const STORAGE_FULL_SAVE_MESSAGE =
  "Your TinyCloud storage is full, so this change was not saved. Reading still works.";
export const STORAGE_TOO_LARGE_SAVE_MESSAGE =
  "This change is larger than the TinyCloud storage you have left, so it was not saved. Reading still works.";
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
  if (!isStorageFullError(error) || readOnly) return;
  readOnly = true;
  for (const listener of listeners) listener();
  emitStoragePaywallError(
    storageSaveMessage(error) ?? STORAGE_FULL_SAVE_MESSAGE,
    isTooLargeError(error) ? "STORAGE_LIMIT_REACHED" : "STORAGE_QUOTA_EXCEEDED",
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
