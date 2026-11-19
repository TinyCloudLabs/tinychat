// TC-3195: a recording share link (`https://tinycloud.one/s/<id>#v=4&k=…&c=…`). Its fragment holds the key to the
// link's sealed record, so it is read once, at startup, and removed from the address bar at once: it never stays
// in history, never reaches a Referer, a log or storage. Only this module's memory holds the link, until the
// share is opened and claimed.
import { firstNonEmpty } from "@/lib/buildEnv";

/** Where share links point. */
export const SHARE_LINK_ORIGIN = firstNonEmpty(import.meta.env.VITE_SHARE_LINK_ORIGIN) ?? "https://tinycloud.one";

const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]{1,64})\/?$/;

let held: string | null = null;

export function isShareLinkPath(pathname: string): boolean {
  return SHARE_PATH.test(pathname);
}

/** The link's id (`/s/<id>`), in lower case as the links service makes them, or `null` when `url` is not a share link. */
export function shareLinkId(url: string): string | null {
  try {
    return SHARE_PATH.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * At startup, before anything renders: keep a share link's full address in memory, drop its fragment from the
 * address bar, and turn off the Referer for the page (`_headers` does that too, but a page the service worker serves
 * skips the header). Returns whether the page is a share link.
 */
export function captureShareLinkFromLocation(location: Location = window.location, history: History = window.history, doc: Document = document): boolean {
  if (!isShareLinkPath(location.pathname)) return false;
  if (!doc.querySelector('meta[name="referrer"]')) {
    const meta = doc.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    doc.head.prepend(meta);
  }
  if (location.hash.length > 1) {
    held = location.href;
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  }
  return true;
}

/**
 * A share link the phone app was opened with (`appUrlOpen`): kept in memory like a page's, and the in-app path to
 * show it at, or `null` when `url` is not a share link.
 */
export function holdShareLinkUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== SHARE_LINK_ORIGIN || !isShareLinkPath(parsed.pathname)) return null;
  held = parsed.hash.length > 1 ? parsed.href : null;
  return parsed.pathname;
}

/** The share link this page was opened with, or `null` (none, or already claimed). */
export function heldShareLink(): string | null {
  return held;
}

/** Forget the link once its share is claimed (or turned down). */
export function releaseShareLink(): void {
  held = null;
}
