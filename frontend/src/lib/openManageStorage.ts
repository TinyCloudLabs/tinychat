import { invoke } from "@tauri-apps/api/core";
import { appPlatform, type AppPlatform } from "@/lib/platform";
import { MANAGE_STORAGE_URL } from "@/lib/storageStatus";

/**
 * App Store guideline 3.1.1 and Google Play's Payments policy: the iOS and Android apps never link to,
 * or open, a page where storage or a plan can be bought. The web and desktop apps do.
 */
export function billingLinksAllowed(platform: AppPlatform): boolean {
  return platform === "web" || platform === "tauri";
}

/**
 * Opens the TinyCloud storage page outside the app: the system browser on desktop
 * (Tauri command, URL fixed in Rust); a new tab on web. Never navigates the app's own webview.
 * The phone apps offer no way to call this; if one is ever wired up, it opens nothing there.
 */
export async function openManageStorage(): Promise<void> {
  const platform = appPlatform();
  if (!billingLinksAllowed(platform)) return;
  if (platform === "tauri") {
    await invoke("open_manage_storage");
    return;
  }
  window.open(MANAGE_STORAGE_URL, "_blank", "noopener,noreferrer");
}
