import { installCaptureEngine, notifyCaptureCapabilitiesChanged, registerCaptureEngine } from "../captureEngine";

/** The one place the web engine is registered; the engine itself is a lazy chunk. */
export function registerWebCaptureEngine(): void {
  registerCaptureEngine("web", () => import("./webEngine").then((m) => m.createBrowserCaptureEngine()));
}

/**
 * Register and install the web engine after boot, and tell the app a recorder is now there. Sign-out uses it when
 * the boot install did not leave an engine, so it can still find voice notes kept only in this browser.
 */
export async function enableWebCaptureEngine(): Promise<void> {
  registerWebCaptureEngine();
  await installCaptureEngine();
  notifyCaptureCapabilitiesChanged();
}
