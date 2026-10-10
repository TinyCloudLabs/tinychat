import { registerCaptureEngine } from "../captureEngine";

/** The one place the web engine is registered; the engine itself is a lazy chunk. */
export function registerWebCaptureEngine(): void {
  registerCaptureEngine("web", () => import("./webEngine").then((m) => m.createBrowserCaptureEngine()));
}
