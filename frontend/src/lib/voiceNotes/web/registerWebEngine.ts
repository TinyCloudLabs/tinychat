import { HOME_SITE } from "../../homeSite";
import { installCaptureEngine, notifyCaptureCapabilitiesChanged, registerCaptureEngine } from "../captureEngine";

/**
 * The one place the web engine is registered; the engine itself is a lazy chunk. The Home site registers it at boot
 * only when this device has used Recording (lib/homeFeatures.ts), else once Recording is covered
 * (enableWebCaptureEngine). The engine is local to the browser; what reaches the space checks the session's rights.
 */
export function registerWebCaptureEngine(enabled: boolean = !HOME_SITE): void {
  if (!enabled) return;
  registerCaptureEngine("web", () => import("./webEngine").then((m) => m.createBrowserCaptureEngine()));
}

/** Register and install the web engine after boot, and tell the app a recorder is now there. */
export async function enableWebCaptureEngine(): Promise<void> {
  registerWebCaptureEngine(true);
  await installCaptureEngine();
  notifyCaptureCapabilitiesChanged();
}
