// Light and dark. The user chooses System (the default), Light or Dark in
// Settings → Appearance; System follows the device, live.
//
// index.html's inline script applies the stored choice before the first paint,
// with the same rules as this module (theme.test.ts runs both on the same
// inputs). main.tsx calls initTheme() to keep it applied afterwards.
import { useSyncExternalStore } from "react";
import { SystemBars, SystemBarsStyle } from "@capacitor/core";

import { appPlatform } from "./platform";

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** Written only when the user chooses, never on mount. */
export const THEME_CHOICE_KEY = "xyz.tinycloud.tinychat:theme-choice";

/**
 * Builds before TC-761 wrote the resolved theme here on every mount, so its
 * value says nothing about a choice. Never read; existing installs keep it.
 */
export const LEGACY_THEME_KEY = "xyz.tinycloud.tinychat:theme";

/** Each theme's --background (index.css), for the browser and PWA chrome: index.html's metas and the manifest. */
export const THEME_COLOR: Record<Theme, string> = { light: "#F6F7F9", dark: "#060B18" };

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage disabled: the page still opens, on System
  }
}

export function readThemeChoice(storage: Pick<Storage, "getItem"> | null = browserStorage()): ThemeChoice {
  let stored: string | null = null;
  try {
    stored = storage?.getItem(THEME_CHOICE_KEY) ?? null;
  } catch {
    // storage disabled: System
  }
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function writeThemeChoice(choice: ThemeChoice, storage: Pick<Storage, "setItem"> | null = browserStorage()): void {
  storage?.setItem(THEME_CHOICE_KEY, choice);
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(SYSTEM_DARK).matches;
}

/**
 * Shows a theme: the `dark` class, the theme-color metas and, in the phone app,
 * the status and navigation bar content. index.html has one meta per system
 * scheme; a chosen theme sets both, System gives each its own scheme's colour.
 */
export function applyTheme(choice: ThemeChoice, systemDark: boolean, doc: Document = document): Theme {
  const theme = resolveTheme(choice, systemDark);
  doc.documentElement.classList.toggle("dark", theme === "dark");
  for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) {
    const own: Theme = meta.getAttribute("media")?.includes("dark") ? "dark" : "light";
    meta.setAttribute("content", THEME_COLOR[choice === "system" ? own : theme]);
  }
  const platform = appPlatform();
  if (platform === "ios" || platform === "android") {
    // Dark = light bar content, for a dark page.
    SystemBars.setStyle({ style: theme === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch((error: unknown) => {
      console.warn("Could not set the system bar style", error);
    });
  }
  return theme;
}

/** Calls `listener` with the device's new preference whenever it changes. */
export function subscribeSystemTheme(listener: (dark: boolean) => void, win: Window = window): () => void {
  const media = win.matchMedia(SYSTEM_DARK);
  const onChange = (event: MediaQueryListEvent) => listener(event.matches);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

// One store for every control that shows or changes the theme (the Settings
// segmented control, the header toggle), so they never disagree.
const listeners = new Set<() => void>();
let current: ThemeChoice | null = null;

function choice(): ThemeChoice {
  current ??= readThemeChoice();
  return current;
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Keeps the page on the current choice: follows the device while the choice is
 * System, and picks up a choice made in another tab. Writes nothing.
 */
export function initTheme(win: Window = window): () => void {
  const media = win.matchMedia(SYSTEM_DARK);
  const sync = () => {
    applyTheme(choice(), media.matches, win.document);
    emit();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_CHOICE_KEY && event.key !== null) return;
    current = readThemeChoice(win.localStorage);
    sync();
  };
  sync();
  const unsubscribe = subscribeSystemTheme(sync, win);
  win.addEventListener("storage", onStorage);
  return () => {
    unsubscribe();
    win.removeEventListener("storage", onStorage);
  };
}

/** The user's choice. The only writer of THEME_CHOICE_KEY. */
export function setThemeChoice(next: ThemeChoice): void {
  current = next;
  applyTheme(next, systemPrefersDark());
  emit();
  writeThemeChoice(next);
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, choice, () => "system");
}

/** The theme on screen (the `dark` class on <html>). */
export function useResolvedTheme(): Theme {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
    () => "light",
  );
}
