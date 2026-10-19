import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { invoke } from "@tauri-apps/api/core";
import { MANAGE_STORAGE_URL } from "@/lib/storageStatus";

/**
 * Opens the TinyCloud storage page outside the app: the system browser on desktop
 * (Tauri command, URL fixed in Rust) and native (Capacitor Browser); a new tab on web.
 * Never navigates the app's own webview.
 */
export async function openManageStorage(): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    await invoke("open_manage_storage");
    return;
  }
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url: MANAGE_STORAGE_URL });
    return;
  }
  window.open(MANAGE_STORAGE_URL, "_blank", "noopener,noreferrer");
}
