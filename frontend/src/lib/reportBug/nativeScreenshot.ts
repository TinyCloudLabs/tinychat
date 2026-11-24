// The phone app's ScreenshotReport plugin (mobile/ios/App/App/ScreenshotReportPlugin.swift,
// mobile/android/.../ScreenshotReportPlugin.java). On a screenshot it renders the app's own window (no Photos
// access), keeps that one JPEG in memory for a minute, and emits `screenshot`. iOS always; Android 14 and later.
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { appPlatform } from "@/lib/platform";

export interface NativeSnapshot { jpegBase64: string; width: number; height: number; bytes: number }

export interface ScreenshotReportNative {
  isSupported(): Promise<{ supported: boolean }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The held snapshot for `id`, which the plugin then drops. Rejects when there is none. */
  takeSnapshot(options: { id: string }): Promise<NativeSnapshot>;
  addListener(event: "screenshot", listener: (event: { id: string; at: number }) => void): Promise<PluginListenerHandle>;
}

export function nativeScreenshotReport(): ScreenshotReportNative | null {
  const platform = appPlatform();
  if ((platform !== "ios" && platform !== "android") || !Capacitor.isPluginAvailable("ScreenshotReport")) return null;
  return registerPlugin<ScreenshotReportNative>("ScreenshotReport");
}
