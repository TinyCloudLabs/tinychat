import { HOME_SITE } from "../../homeSite";
import { registerCaptureEngine } from "../captureEngine";

/**
 * The one place the web engine is registered; the engine itself is a lazy chunk. The Home site registers none:
 * Recording lives on tinycloud.chat, and without an engine nothing in the Home build can record.
 */
export function registerWebCaptureEngine(homeSite: boolean = HOME_SITE): void {
  if (homeSite) return;
  registerCaptureEngine("web", () => import("./webEngine").then((m) => m.createBrowserCaptureEngine()));
}
