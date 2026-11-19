// Links in the Feed open inside the app (TC-3404). A plain tap or click
// on an http(s) link to another site opens it over the Feed: on the phone app in the system's in-app browser
// (Capacitor Browser: a Safari view on iOS, a Custom Tab on Android), on the web in a sheet that rises from the bottom
// (LinkSheet.tsx). Everything else keeps the plain link: cmd/ctrl/shift/alt or middle clicks, mailto: and other
// schemes, links to this app's own origin, the desktop app (its content policy frames only sign-in), and any screen
// without a sheet mounted.
import { useEffect, useSyncExternalStore } from "react";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";

/** The phone app's in-app browser. An object of its own so tests can stand in for it: Capacitor's plugin proxy ignores spies. */
export const nativeBrowser = { open: (url: string): Promise<void> => Browser.open({ url }) };

/** The address a link opens inside the app: an absolute http(s) address on another origin, else undefined. */
export function inAppTarget(href: string, here: string = window.location.href): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  // This app's own pages run the app; a frame or a second browser would run it without the owner's session.
  if (url.origin === new URL(here).origin) return undefined;
  return url.href;
}

// Sites whose pages refuse to be shown in another site's frame (X-Frame-Options or CSP frame-ancestors, checked
// 2026-11). The sheet shows a short note and "Open in browser" for these instead of a blank frame. A site missing
// from the list still opens in the frame, with the same button and a hint under it.
const REFUSES_FRAMING: Record<string, true> = Object.fromEntries([
  "github.com", "gist.github.com", "linear.app",
  "google.com", "docs.google.com", "drive.google.com", "accounts.google.com", "mail.google.com",
  "youtube.com", "m.youtube.com", "youtu.be", "x.com", "twitter.com",
  "news.ycombinator.com", "developer.mozilla.org", "cloudflare.com", "dash.cloudflare.com",
  "medium.com", "nytimes.com", "bbc.com",
].map((host) => [host, true as const]));

/** The host a person recognises: the address's host without a leading www. */
export function displayHost(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

/** True for a site known to refuse being shown inside another page. */
export function refusesFraming(url: string): boolean {
  return REFUSES_FRAMING[displayHost(url)] === true;
}

/** The part of a click that decides where a link opens. */
export interface LinkClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

/** A primary click with no modifier that nothing else has handled: the only click the app takes over. */
export function plainClick(click: LinkClick): boolean {
  return click.button === 0 && !click.metaKey && !click.ctrlKey && !click.shiftKey && !click.altKey && !click.defaultPrevented;
}

// The web sheet's state: the page it shows, whether it is open (the address stays while it closes, so the sheet
// does not empty mid-animation) and the link that opened it, where focus goes back when it closes. `hosts` counts
// mounted sheets: with none, a link stays a plain link.
export interface LinkSheetState { url: string | null; open: boolean; opener?: HTMLElement }
let state: LinkSheetState = { url: null, open: false };
let hosts = 0;
const listeners = new Set<() => void>();
function publish(next: typeof state) {
  state = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Closes the web sheet. */
export function closeLinkSheet(): void {
  if (state.open) publish({ ...state, open: false });
}

/** The page the web sheet shows, whether it is open and the link that opened it. */
export function useLinkSheet(): LinkSheetState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Registers the caller as the screen's web sheet for as long as it is mounted. */
export function useLinkSheetHost(): void {
  useEffect(() => {
    hosts++;
    return () => {
      hosts--;
      if (hosts === 0) publish({ url: null, open: false });
    };
  }, []);
}

/**
 * Where a click on a Feed link goes. "browser": left to the browser, as a plain link. "native": the phone app's
 * in-app browser. "sheet": the web sheet. Only "browser" leaves the click's default action in place. `sheet: false`
 * keeps a link out of the web sheet: a page that signs with a passkey or needs the owner's sign-in (an approval)
 * cannot do either in a frame, so on the web it opens in a new tab; the phone app's browser can do both.
 */
export function openLinkInApp(href: string, click: LinkClick, { sheet = true, opener }: { sheet?: boolean; opener?: HTMLElement } = {}): "browser" | "native" | "sheet" {
  if (!plainClick(click)) return "browser";
  const url = inAppTarget(href);
  if (!url || "__TAURI_INTERNALS__" in window) return "browser";
  if (Capacitor.isNativePlatform()) {
    click.preventDefault();
    // Rejected only when it cannot show the page (one already open, or no browser on the device): the tap does nothing.
    nativeBrowser.open(url).catch(() => {});
    return "native";
  }
  if (!sheet || hosts === 0) return "browser";
  click.preventDefault();
  publish({ url, open: true, opener });
  return "sheet";
}
