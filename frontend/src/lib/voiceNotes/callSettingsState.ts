// The answers of the desktop app's two call settings (names in the call, the call prompt tile), checked before use. Only
// Capture settings reads them, so they load with its chunk, not with the entry chunk (TC-2882); desktopCaptureExtras.ts
// names them too.
import type { CallNamesState, CallPromptState } from "./desktopCaptureExtras";

/** `answer` as the setting's state; null for anything but `{ enabled: boolean, supported: boolean }`. */
export function readCallPromptState(answer: unknown): CallPromptState | null {
  if (answer === null || typeof answer !== "object") return null;
  const { enabled, supported } = answer as { enabled?: unknown; supported?: unknown };
  return typeof enabled === "boolean" && typeof supported === "boolean" ? { enabled, supported } : null;
}

/** `answer` as the setting's state; null for anything but `{ enabled: boolean, permission: "granted" | "missing" | "unsupported" }`. */
export function readCallNamesState(answer: unknown): CallNamesState | null {
  if (answer === null || typeof answer !== "object") return null;
  const { enabled, permission } = answer as { enabled?: unknown; permission?: unknown };
  if (typeof enabled !== "boolean") return null;
  return permission === "granted" || permission === "missing" || permission === "unsupported" ? { enabled, permission } : null;
}
