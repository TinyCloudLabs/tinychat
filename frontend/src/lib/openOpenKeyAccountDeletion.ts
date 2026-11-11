import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";

/**
 * OpenKey's account deletion page (App Store guideline 5.1.1(v)). The account,
 * its keys and its sign-in methods live on OpenKey, so deletion happens there:
 * it needs a fresh passkey or email code, which only openkey.so can ask for.
 * The host is the same one App.tsx signs in with (VITE_OPENKEY_HOST).
 */
export function openKeyAccountDeletionUrl(host: string = import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so"): string {
  return new URL("/dashboard/settings/delete-account", host).toString();
}

/**
 * Opens the deletion page outside the app: the in-app system browser sheet on
 * the phone (Capacitor Browser), a new tab on the web. Never the app's webview.
 */
export async function openOpenKeyAccountDeletion(): Promise<void> {
  const url = openKeyAccountDeletionUrl();
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
