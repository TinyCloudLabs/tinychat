// Whether the SDK's floating TinyCloud button is shown in this browser (TC-2130).
//
// The SDK is built with `ui.button: false` (packages/client/src/tinycloud.ts), so the button is hidden
// unless the user turns it on in Settings > TinyCloud. The choice is per device (localStorage), OFF by
// default, and the SDK does not persist it: TinyCloudButtonSync (chat/) pushes this value into the
// SDK on load and on every change through `tcw.ui.setButtonVisible`.
import { useSyncExternalStore } from "react";
import type { TinyCloudUI, TinyCloudWeb } from "@tinycloud/web-sdk";

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

// `setButtonVisible` ships in the next web-sdk beta; the installed typings do not have it yet.
type ButtonControl = { setButtonVisible?: (visible: boolean) => void };

/** Pushes the saved value into the SDK. Safe against a client whose `ui` is missing or older. */
export function applyTinyCloudButton(tcw: TinyCloudWeb, shown: boolean): void {
  const ui = tcw.ui as (TinyCloudUI & ButtonControl) | undefined;
  if (typeof ui?.setButtonVisible === "function") ui.setButtonVisible(shown);
}
