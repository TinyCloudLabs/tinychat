// TC-3547: where an owner goes when the SDK says this page cannot publish their registry record ("needs-one"). Only
// TinyCloud One and Home publish; everywhere else the SDK signs nothing and the owner finishes setup on TinyCloud One.
import { Browser } from "@capacitor/browser";
import { AccountSetupRequiredError } from "@tinycloud/sdk-core";
import { appPlatform } from "../platform";

/** The SDK's own setup address (`https://tinycloud.one/?finish-setup=registry`). */
export const REGISTRY_SETUP_URL: string = new AccountSetupRequiredError().setupUrl;

/** False in the desktop app: it has no way to open an outside address, so a card that leads there would lead nowhere. */
export function canOpenRegistrySetupLink(platform = appPlatform()): boolean {
  return platform !== "tauri";
}

/**
 * Send the owner to TinyCloud One: the phone apps open the in-app browser sheet, the web goes there in this tab. Nothing
 * happens when this page already is TinyCloud One (OpenKey refused the sign there; another visit would refuse again) or
 * in the desktop app.
 */
export async function openRegistrySetupLink(currentOrigin: string, platform = appPlatform()): Promise<void> {
  if (currentOrigin === new URL(REGISTRY_SETUP_URL).origin || !canOpenRegistrySetupLink(platform)) return;
  if (platform === "ios" || platform === "android") {
    await Browser.open({ url: REGISTRY_SETUP_URL });
    return;
  }
  window.location.assign(REGISTRY_SETUP_URL);
}
