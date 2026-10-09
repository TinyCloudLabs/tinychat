import { appPlatform, type AppPlatform } from "@/lib/platform";

export type RecorderShell = "phone" | "desktop" | "web";
export type RecorderLayout = "phone" | "rail" | "desktop";
export interface ShellCapabilities {
  shell: RecorderShell;
  localTranscription: boolean;
  backgroundRecording: boolean;
  systemAudio: boolean;
  meetingSources: boolean;
  captureSettings: boolean;
  globalShortcuts: boolean;
  notYetUploadedList: boolean;
}
export function shellForPlatform(platform: AppPlatform): RecorderShell {
  if (platform === "ios" || platform === "android") return "phone";
  if (platform === "tauri") return "desktop";
  if (platform === "web") return "web";
  const exhaustive: never = platform;
  throw new Error(`Unsupported platform: ${String(exhaustive)}`);
}
export function shellCapabilities(platform: AppPlatform = appPlatform()): ShellCapabilities {
  const shell = shellForPlatform(platform);
  if (shell === "phone") return { shell, localTranscription: true, backgroundRecording: true, systemAudio: false, meetingSources: false, captureSettings: false, globalShortcuts: false, notYetUploadedList: true };
  if (shell === "desktop") return { shell, localTranscription: true, backgroundRecording: true, systemAudio: true, meetingSources: true, captureSettings: true, globalShortcuts: true, notYetUploadedList: true };
  return { shell, localTranscription: false, backgroundRecording: false, systemAudio: false, meetingSources: false, captureSettings: false, globalShortcuts: false, notYetUploadedList: false };
}
export function recorderLayout(width: number): RecorderLayout {
  if (!Number.isFinite(width) || width < 0) throw new RangeError("width must be a non-negative finite number");
  return width < 768 ? "phone" : width < 1024 ? "rail" : "desktop";
}
export function recorderSizing(width: number, mainAreaHeight: number): { ringPx: 214 | 172; timerPx: 76 | 60 } {
  if (!Number.isFinite(mainAreaHeight) || mainAreaHeight < 0) throw new RangeError("mainAreaHeight must be a non-negative finite number");
  return width >= 768 && mainAreaHeight >= 700 ? { ringPx: 214, timerPx: 76 } : { ringPx: 172, timerPx: 60 };
}
