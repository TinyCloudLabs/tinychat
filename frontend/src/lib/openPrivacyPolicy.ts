import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { invoke } from "@tauri-apps/api/core";

/** TinyCloud's privacy policy (App Store 5.1.1(i), Play User Data policy: linked from inside the app). */
export const PRIVACY_POLICY_URL = "https://tinycloud.xyz/privacy";

/**
 * Opens the privacy policy outside the app's own webview: the system browser on
 * desktop (Tauri command, URL fixed in Rust), the in-app browser sheet on the
 * phone (Capacitor Browser), a new tab on the web.
 */
export async function openPrivacyPolicy(): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    await invoke("open_privacy_policy");
    return;
  }
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url: PRIVACY_POLICY_URL });
    return;
  }
  window.open(PRIVACY_POLICY_URL, "_blank", "noopener,noreferrer");
}
