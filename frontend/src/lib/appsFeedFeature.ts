import { useSyncExternalStore } from "react";

export const APPS_FEED_FEATURE_KEY = "exo:experimental:apps-feed";
const FEATURE_EVENT = "tinychat:experimental-feature";

export function appsFeedEnabled(): boolean {
  try { return window.localStorage.getItem(APPS_FEED_FEATURE_KEY) === "true"; }
  catch { return false; }
}

export function setAppsFeedEnabled(enabled: boolean): void {
  try { window.localStorage.setItem(APPS_FEED_FEATURE_KEY, String(enabled)); }
  catch { /* Keep the current page usable when storage is unavailable. */ }
  window.dispatchEvent(new CustomEvent(FEATURE_EVENT, { detail: { key: APPS_FEED_FEATURE_KEY, enabled } }));
}

function subscribe(listener: () => void): () => void {
  const onFeature = (event: Event) => {
    if ((event as CustomEvent<{ key?: string }>).detail?.key === APPS_FEED_FEATURE_KEY) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === APPS_FEED_FEATURE_KEY || event.key === null) listener();
  };
  window.addEventListener(FEATURE_EVENT, onFeature);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(FEATURE_EVENT, onFeature);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppsFeedEnabled(): boolean {
  return useSyncExternalStore(subscribe, appsFeedEnabled, () => false);
}
