// A few settings in the phone app must outlive its WebView storage. WebView storage belongs to one origin,
// so it is left behind when the app's origin changes (TC-3045). These keys are therefore also kept in native
// storage (Capacitor Preferences): the app's own preferences file, kept until the app is uninstalled.
//
// localStorage stays what the app reads, synchronously, as before; native storage is the durable copy.
// Before the app renders, hydrateDurableKeys reconciles the two. The first time in a given WebView storage
// (a new origin, or the first launch of a build with this module), whatever either side has is kept: a key only
// native storage has is copied into localStorage, and a key localStorage has is copied to native storage. From
// then on that localStorage is the record, removals included, and every write goes to both.
//
// Rendering waits for this only briefly (main.tsx). Anything that must not act on a stale value waits for its
// key with durableKeyReady: the boot restore for the sign-out fence, the app lock for its settings.
//
// Native storage here is NOT a secret store: it is a plain, unencrypted preferences file (NSUserDefaults /
// SharedPreferences) and goes into device backups. Never put a key, token or anything secret in a durable key.
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

export interface DurableStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

type WebStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const durableKeys = new Set<string>();
let store: DurableStore | null = null;
// Per key, once reconciled: whether localStorage's value can be trusted (see durableKeyReady).
const readiness = new Map<string, Promise<boolean>>();

/** Set in localStorage once it has been reconciled with native storage: from then on, its removals count. */
export const DURABLE_KEYS_RECONCILED = "xyz.tinycloud.home:durable-keys";

/** Capacitor Preferences in the phone app; null on the web and desktop, where WebView storage is the only copy. */
export function nativeDurableStore(): DurableStore | null {
  if (!Capacitor.isNativePlatform()) return null;
  return {
    get: async (key) => (await Preferences.get({ key })).value,
    set: (key, value) => Preferences.set({ key, value }),
    remove: (key) => Preferences.remove({ key }),
  };
}

function webStorage(): WebStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Reconciles `keys` between native storage and localStorage, then mirrors every later write to them. Never
 * throws; a key that can't be reconciled keeps whatever localStorage has, and the reconciliation runs again on
 * the next launch.
 */
export async function hydrateDurableKeys(
  keys: readonly string[],
  durable: DurableStore | null = nativeDurableStore(),
  web: WebStorage | null = webStorage(),
): Promise<void> {
  store = durable;
  for (const key of keys) durableKeys.add(key);
  if (!durable || !web) return;
  let reconciled: boolean;
  try {
    reconciled = web.getItem(DURABLE_KEYS_RECONCILED) === "1";
  } catch {
    return;
  }
  const results = keys.map(async (key) => {
    try {
      const [saved, local] = [await durable.get(key), web.getItem(key)];
      if (local === null && saved !== null) {
        // Removed here since the last launch (a mirror removal that didn't land), or a new WebView storage.
        if (reconciled) await durable.remove(key);
        else web.setItem(key, saved);
      } else if (local !== null && saved !== local) {
        await durable.set(key, local);
      }
      return true;
    } catch (error) {
      console.warn(`Could not reconcile ${key} with native storage`, error);
      return false;
    }
  });
  // Once reconciled, localStorage is the record whatever native storage did; before that, only a read counts.
  keys.forEach((key, index) => readiness.set(key, results[index]!.then((ok) => ok || reconciled)));
  if (!(await Promise.all(results)).every(Boolean) || reconciled) return;
  try {
    web.setItem(DURABLE_KEYS_RECONCILED, "1");
  } catch {
    // Reconciled again next launch.
  }
}

/**
 * Resolves when `key` has been reconciled: true if localStorage now holds its value, false if it may not (native
 * storage could not be read, or did not answer within `timeoutMs`, in a WebView storage never reconciled
 * before). Resolves true at once where nothing is reconciled (the web, desktop, tests).
 */
export function durableKeyReady(key: string, timeoutMs = 10_000): Promise<boolean> {
  const ready = readiness.get(key);
  if (!ready) return Promise.resolve(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  return Promise.race([ready, timeout]).finally(() => clearTimeout(timer));
}

/** Writes `value` (null removes) to localStorage and, for a durable key in the phone app, to native storage. */
export function writeDurableKey(
  key: string,
  value: string | null,
  web: (Pick<Storage, "setItem"> & Partial<Pick<Storage, "removeItem">>) | null = webStorage(),
): void {
  if (value === null) web?.removeItem?.(key);
  else web?.setItem(key, value);
  if (!store || !durableKeys.has(key)) return;
  const write = value === null ? store.remove(key) : store.set(key, value);
  void write.catch((error: unknown) => console.warn(`Could not keep ${key} in native storage`, error));
}

/** For tests: forget the store and keys set by hydrateDurableKeys. */
export function resetDurableKeysForTest(): void {
  store = null;
  durableKeys.clear();
  readiness.clear();
}
