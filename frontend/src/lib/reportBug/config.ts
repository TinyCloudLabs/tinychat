// TC-3716 Report a bug: the build flag, the feedback host, the person's offer setting and the Settings row's
// open request. Small on purpose: this file is in the main bundle, the sheet itself is loaded on demand.
import { useSyncExternalStore } from "react";
import { firstNonEmpty } from "@/lib/buildEnv";
import { isShareLinkPath } from "@/lib/nativeShares/link";

/** On only when VITE_REPORT_BUG is exactly "true". Off: no Settings row, no screenshot watching, no sheet. */
export const REPORT_BUG_ENABLED = import.meta.env.VITE_REPORT_BUG === "true";

/** When this bundle started: screenshots in the first seconds are of the boot and sign-in screens (offerPolicy.ts). */
export const APP_STARTED_AT = Date.now();

/**
 * Where reports go. The host (feedback.tinycloud.xyz today, or feedback.tinycloud.one once it exists) is Sam's
 * call, so it is build config. Only https, or http on loopback for a local Worker.
 */
export function feedbackOrigin(raw: string | undefined): string {
  const url = new URL(firstNonEmpty(raw) ?? "https://feedback.tinycloud.xyz");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error(`VITE_FEEDBACK_ORIGIN must be https: ${url.origin}`);
  return url.origin;
}

export const FEEDBACK_ORIGIN = feedbackOrigin(import.meta.env.VITE_FEEDBACK_ORIGIN);

// The offer setting: on unless the person turned it off. This device only.
export const REPORT_BUG_OFFER_KEY = "xyz.tinycloud.home:report-bug-offer";

const listeners = new Set<() => void>();
const storage = () => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function offerAfterScreenshot(): boolean {
  return storage()?.getItem(REPORT_BUG_OFFER_KEY) !== "off";
}

export function setOfferAfterScreenshot(on: boolean): void {
  if (on) storage()?.removeItem(REPORT_BUG_OFFER_KEY);
  else storage()?.setItem(REPORT_BUG_OFFER_KEY, "off");
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useOfferAfterScreenshot(): boolean {
  return useSyncExternalStore(subscribe, offerAfterScreenshot, offerAfterScreenshot);
}

// The Settings row asks the mounted sheet host to open.
const openRequests = new Set<() => void>();

export function requestReportBug(): void {
  for (const open of openRequests) open();
}

export function onReportBugRequest(open: () => void): () => void {
  openRequests.add(open);
  return () => { openRequests.delete(open); };
}

/**
 * Screens that can show private details, where a screenshot's snapshot starts detached: account settings, a framed
 * app, a share link being opened (its token, or the /s/<id> address before the token is read).
 */
export function isSensitiveScreen(screen: { id: string; appId?: string }, pathname: string, shareToken: string | null): boolean {
  return screen.id === "settings" || Boolean(screen.appId) || Boolean(shareToken) || isShareLinkPath(pathname);
}

// Surfaces open over any screen that show a secret (the share sheet's link with its key) hold the screen sensitive.
let sensitiveHolds = 0;

/** Marks the screen sensitive until the returned release runs (once). */
export function holdScreenSensitive(): () => void {
  sensitiveHolds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sensitiveHolds--;
  };
}

export function screenSensitiveHeld(): boolean {
  return sensitiveHolds > 0;
}
