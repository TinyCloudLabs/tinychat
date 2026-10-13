import { createContext } from "react";
import { Capacitor } from "@capacitor/core";

/**
 * Where Exo is running: the phone app (Capacitor, iOS or Android), the desktop
 * app (Tauri) or a browser (the web app and the installed PWA).
 */
export type AppPlatform = "ios" | "android" | "tauri" | "web";

export function appPlatform(): AppPlatform {
  if (Capacitor.isNativePlatform()) {
    const platform = Capacitor.getPlatform();
    if (platform === "ios" || platform === "android") return platform;
  }
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return "tauri";
  return "web";
}

/** The platform screens render for: appPlatform() unless a provider says otherwise (the screenshot harness does, per capture). */
export const PlatformContext = createContext<AppPlatform>(appPlatform());
