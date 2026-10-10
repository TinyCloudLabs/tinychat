import { recorderFinalEnabled } from "@/capture/recorder/final/recorderFinalFlag";
import { registerCaptureEngine } from "../captureEngine";

/** The one place the Tauri engine is registered. With the flag off nothing is registered and the engine chunk is never fetched. */
export function registerDesktopCaptureEngine(): void {
  if (!recorderFinalEnabled()) return;
  registerCaptureEngine("tauri", () => import("./desktopVoiceNotes").then((m) => m.createTauriDesktopEngine()));
}
