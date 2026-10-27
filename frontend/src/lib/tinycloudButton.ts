// Whether the SDK's floating TinyCloud button is shown in this browser (TC-2130).
//
// The SDK is built with `ui.button: false` (packages/client/src/tinycloud.ts), so the button is hidden
// unless the user turns it on in Settings > TinyCloud. The choice is per device (localStorage), OFF by
// default, and the SDK does not persist it: TinyCloudButtonSync (chat/) pushes this value into the
// SDK on load and on every change through `tcw.ui.setButtonVisible`.
import { useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

export const TINYCLOUD_BUTTON_KEY = "tinychat:ui:tinycloud-button-shown";
const CHANGE_EVENT = "tinychat:tinycloud-button";

/** Only an explicit "true" shows the button; a missing, unreadable or any other value is OFF. */
export function readTinyCloudButtonShown(): boolean {
  try { return window.localStorage.getItem(TINYCLOUD_BUTTON_KEY) === "true"; }
  catch { return false; }
}

export function setTinyCloudButtonShown(shown: boolean): void {
  try { window.localStorage.setItem(TINYCLOUD_BUTTON_KEY, String(shown)); }
  catch { /* Keep this tab usable when storage is unavailable; the choice just will not outlive it. */ }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === TINYCLOUD_BUTTON_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTinyCloudButtonShown(): boolean {
  return useSyncExternalStore(subscribe, readTinyCloudButtonShown, () => false);
}

/** Pushes the saved value into the SDK: true shows the button, false hides it (the SDK stores neither). */
export function applyTinyCloudButton(tcw: TinyCloudWeb, shown: boolean): void {
  // `?.`: the App test fixtures stand in a bare object for the client, which has no `ui`; the real SDK always has one.
  tcw.ui?.setButtonVisible(shown);
}
