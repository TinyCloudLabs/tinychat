import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSetting, setSetting } from "../lib/threadStore";
import { accountStorageKey } from "../lib/voiceNotes/sourcePins";

export type FirstScreen = "feed" | "apps";
const FIRST_SCREEN_KEY = "home-first-screen";
export const FIRST_SCREEN_CACHE_KEY = "exo.home.firstScreen";

/**
 * A device-local, per-account copy of the choice so Home can decide without
 * waiting on a slow node read. The account setting stays the source of truth:
 * the copy is refreshed from every successful read and write. Any storage
 * problem (no storage, a throwing store, an unrecognised value) is "no copy".
 */
export function readCachedFirstScreen(
  did: string | null | undefined,
  storage?: Pick<Storage, "getItem">,
): FirstScreen | null {
  if (!did) return null;
  try {
    const value = (storage ?? globalThis.localStorage)?.getItem(accountStorageKey(FIRST_SCREEN_CACHE_KEY, did));
    return value === "feed" || value === "apps" ? value : null;
  } catch {
    return null;
  }
}

function cacheFirstScreen(did: string | null | undefined, screen: FirstScreen, storage?: Pick<Storage, "setItem">): void {
  if (!did) return;
  try {
    (storage ?? globalThis.localStorage)?.setItem(accountStorageKey(FIRST_SCREEN_CACHE_KEY, did), screen);
  } catch { /* No copy is the safe state. */ }
}

export async function readFirstScreen(tcw: TinyCloudWeb, did?: string | null): Promise<FirstScreen> {
  const screen: FirstScreen = (await getSetting(tcw, FIRST_SCREEN_KEY)) === "apps" ? "apps" : "feed";
  cacheFirstScreen(did, screen);
  return screen;
}

export async function writeFirstScreen(tcw: TinyCloudWeb, screen: FirstScreen, did?: string | null): Promise<void> {
  await setSetting(tcw, FIRST_SCREEN_KEY, screen);
  cacheFirstScreen(did, screen);
}
