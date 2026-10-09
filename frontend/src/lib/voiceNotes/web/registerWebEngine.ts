import { recorderFinalEnabled } from "@/capture/recorder/final/recorderFinalFlag";
import { registerCaptureEngine } from "../captureEngine";

/** The one place the web engine is registered. With the flag off nothing is registered and the engine chunk is never fetched. */
export function registerWebCaptureEngine(): void {
  if (!recorderFinalEnabled()) return;
  registerCaptureEngine("web", () => import("./webEngine").then((m) => m.createBrowserCaptureEngine()));
}
