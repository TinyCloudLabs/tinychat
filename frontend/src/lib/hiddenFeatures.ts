// Settings → "Show hidden features": features that are off by default show only while this is on. Off by default,
// this device only (it doesn't sync). Kept in a durable key so the phone app keeps it when its WebView origin changes
// (durableKeys.ts); main.tsx hydrates it before the app renders.
import { useSyncExternalStore } from "react";

import { writeDurableKey } from "./durableKeys";

export const HIDDEN_FEATURES_KEY = "xyz.tinycloud.home:show-hidden-features";

type ReadStorage = Pick<Storage, "getItem">;

function webStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** True only when the stored value is exactly "1"; anything else, or storage that cannot be read, is off. */
export function readShowHiddenFeatures(storage: ReadStorage | null = webStorage()): boolean {
  try {
    return storage?.getItem(HIDDEN_FEATURES_KEY) === "1";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();
// Where storage cannot be written, the choice still holds until the app is closed.
let override: boolean | null = null;

function currentValue(): boolean {
  return override ?? readShowHiddenFeatures();
}

export function setShowHiddenFeatures(show: boolean): void {
  try {
    writeDurableKey(HIDDEN_FEATURES_KEY, show ? "1" : null);
    override = null;
  } catch (error) {
    console.warn("Could not store the hidden features setting; it applies until the app is closed", error);
    override = show;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === HIDDEN_FEATURES_KEY || event.key === null) listener(); };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/** Whether features marked hidden are shown; re-renders when Settings changes it (or another tab does). */
export function useShowHiddenFeatures(): boolean {
  return useSyncExternalStore(subscribe, currentValue, () => false);
}

/** For tests: forget the in-memory override. */
export function resetHiddenFeaturesForTest(): void {
  override = null;
  listeners.clear();
}
