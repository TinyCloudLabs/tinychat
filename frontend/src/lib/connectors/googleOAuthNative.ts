// Google connector OAuth inside the Exo native app (TC-521).
//
// Google refuses consent inside embedded WebViews (`disallowed_useragent`), and a
// Capacitor WebView has neither the popup nor the `window.opener` that the web
// flow's postMessage needs. So the native app runs the SAME authorization-code +
// PKCE flow in the system browser (Custom Tabs on Android, SFSafariViewController
// on iOS) and gets `{ code, state }` back through a deep link:
//
//   app ─ Browser.open ─▶ backend /start ─302─▶ Google consent ─302─▶ backend /callback
//     ◀─ appUrlOpen ─ xyz.tinycloud.exo://oauth/google?code=…&state=native.… ◀─302─┘
//
// The backend takes that return ONLY for a state tagged `native.` (see "Native
// (Exo app) return" in backend/src/routes/google-oauth.ts); the web SPA's untagged
// states keep the popup, unchanged. The registered Google redirect URI is still
// the backend's /callback, so nothing changes in the Google Cloud console.
//
// What this module guarantees on the app side:
//   - a return is accepted only from the exact deep link, carrying exactly one
//     `state` equal to the one this attempt minted, and exactly one `code` (or
//     the backend's constant "not completed" error). Anything else is ignored
//     silently, like a stray postMessage on the web;
//   - one outcome per attempt: the first accepted return wins, everything after
//     it is ignored, and the listeners are removed;
//   - the PKCE verifier never passes through here. The dialog keeps it in memory
//     and runs the authenticated exchange, exactly as on the web.

import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";

/** The client tag the backend reads from `state`. Must match `NATIVE_OAUTH_CLIENT` there. */
export const NATIVE_OAUTH_STATE_PREFIX = "native.";

/**
 * The fixed deep link the backend returns to. Must match `NATIVE_OAUTH_RETURN_URL`
 * in the backend, the Android intent-filter and iOS `CFBundleURLSchemes`.
 */
export const NATIVE_OAUTH_RETURN_URL = "xyz.tinycloud.exo://oauth/google";

/** The one `error` value a native return carries (a denial or a malformed return). */
export const NATIVE_OAUTH_NOT_COMPLETED = "not_completed";

/**
 * How long a closed browser waits for the deep link before it counts as a cancel.
 * On Android the Custom Tab closes BECAUSE the deep link brought the app forward,
 * so "browser closed" and "app URL opened" can arrive in either order.
 */
export const BROWSER_CLOSED_GRACE_MS = 1500;

/** The state for one native attempt: the tag, then the attempt's CSPRNG nonce. */
export function nativeOAuthState(nonce: string): string {
  return `${NATIVE_OAUTH_STATE_PREFIX}${nonce}`;
}

export type NativeOAuthReturn =
  | { kind: "code"; code: string }
  | { kind: "not-completed" };

/**
 * Read a URL the OS opened the app with. `null` unless it is THIS attempt's
 * return: the exact deep-link prefix (string compare, not `new URL`, whose host
 * parsing for custom schemes differs across WebView versions), no fragment, and
 * exactly `{ code, state }` or `{ error: not_completed, state }` with the state
 * equal to `expectedState`.
 */
export function parseNativeOAuthReturn(
  url: string,
  expectedState: string,
): NativeOAuthReturn | null {
  const prefix = `${NATIVE_OAUTH_RETURN_URL}?`;
  if (!url.startsWith(prefix) || url.includes("#")) return null;
  if (!expectedState.startsWith(NATIVE_OAUTH_STATE_PREFIX)) return null;
  const query = new URLSearchParams(url.slice(prefix.length));
  const keys = [...query.keys()];
  if (keys.length !== 2) return null;
  const states = query.getAll("state");
  if (states.length !== 1 || states[0] !== expectedState) return null;
  const [code, ...extraCodes] = query.getAll("code");
  if (code !== undefined && code.length > 0 && extraCodes.length === 0) {
    return { kind: "code", code };
  }
  const errors = query.getAll("error");
  if (errors.length === 1 && errors[0] === NATIVE_OAUTH_NOT_COMPLETED) {
    return { kind: "not-completed" };
  }
  return null;
}

/** A listener registration that can be undone (Capacitor's `PluginListenerHandle`). */
export interface NativeListenerHandle {
  remove(): Promise<void> | void;
}

/** The native capabilities one attempt uses. Injected so the flow is testable without a device. */
export interface NativeOAuthPorts {
  /** Open `url` in the system browser. */
  openBrowser(url: string): Promise<void>;
  /** Dismiss the browser if it is still up (iOS keeps SFSafariViewController over the app). */
  closeBrowser(): Promise<void>;
  /** The user closed the browser, or the OS did. */
  onBrowserClosed(listener: () => void): Promise<NativeListenerHandle>;
  /** The OS opened the app with a URL. */
  onAppUrlOpen(listener: (url: string) => void): Promise<NativeListenerHandle>;
}

/**
 * Whether Google OAuth runs in the system browser: inside the Capacitor app
 * only. The web and the Tauri desktop app keep the popup.
 */
export function usesSystemBrowserOAuth(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * The Capacitor ports, or `null` outside the native app: the one gate that
 * picks the system-browser flow over the popup. A native shell missing a plugin
 * still gets the ports, so the attempt fails visibly as "browser-unavailable"
 * instead of falling back to a popup Google would refuse.
 */
export function capacitorNativeOAuthPorts(): NativeOAuthPorts | null {
  if (!usesSystemBrowserOAuth()) return null;
  return {
    openBrowser: (url) => Browser.open({ url }),
    closeBrowser: () => Browser.close(),
    onBrowserClosed: (listener) => Browser.addListener("browserFinished", listener),
    onAppUrlOpen: (listener) =>
      App.addListener("appUrlOpen", (event) => listener(event.url)),
  };
}

export type NativeOAuthOutcome =
  | { kind: "code"; code: string }
  /** The backend's "not completed" return, or the browser closed without a return. */
  | { kind: "cancelled" }
  /** The browser could not be opened, or the listeners could not be registered. */
  | { kind: "browser-unavailable" };

export interface NativeOAuthAttempt {
  /** Stop waiting: remove the listeners and dismiss the browser. Reports no outcome. */
  cancel(): void;
}

interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Remove now; a removal that throws or rejects has nothing left to tell anyone. */
function removeQuietly(handle: NativeListenerHandle): void {
  try {
    void Promise.resolve(handle.remove()).catch(() => undefined);
  } catch {
    // Already gone.
  }
}

/**
 * Run one system-browser attempt: listen first, then open `url`, then report
 * exactly one outcome (unless cancelled first). The listeners are registered
 * BEFORE the browser opens, so a return can never arrive unheard.
 */
export function startNativeOAuth(input: {
  ports: NativeOAuthPorts;
  url: string;
  expectedState: string;
  onOutcome: (outcome: NativeOAuthOutcome) => void;
  closedGraceMs?: number;
  timers?: Timers;
}): NativeOAuthAttempt {
  const { ports, expectedState, onOutcome } = input;
  const timers = input.timers ?? DEFAULT_TIMERS;
  const graceMs = input.closedGraceMs ?? BROWSER_CLOSED_GRACE_MS;
  let finished = false;
  let graceTimer: unknown = null;
  const handles: NativeListenerHandle[] = [];

  const finish = (): void => {
    finished = true;
    if (graceTimer !== null) {
      timers.clear(graceTimer);
      graceTimer = null;
    }
    for (const handle of handles.splice(0)) removeQuietly(handle);
    // Best effort: on Android the tab is already gone and this resolves; on iOS it
    // rejects when nothing is presented. Neither is an error worth reporting.
    void ports.closeBrowser().catch(() => undefined);
  };

  const settle = (outcome: NativeOAuthOutcome): void => {
    if (finished) return;
    finish();
    onOutcome(outcome);
  };

  const onUrl = (url: string): void => {
    if (finished) return;
    const parsed = parseNativeOAuthReturn(url, expectedState);
    // Not ours, stale (an earlier attempt's link), or forged: ignored, and the
    // attempt keeps waiting for its own return.
    if (parsed === null) return;
    settle(parsed.kind === "code" ? { kind: "code", code: parsed.code } : { kind: "cancelled" });
  };

  const onClosed = (): void => {
    if (finished || graceTimer !== null) return;
    graceTimer = timers.set(() => {
      graceTimer = null;
      settle({ kind: "cancelled" });
    }, graceMs);
  };

  void (async () => {
    const registered = await Promise.allSettled([
      ports.onAppUrlOpen(onUrl),
      ports.onBrowserClosed(onClosed),
    ]);
    const ok = registered.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (finished || ok.length !== registered.length) {
      for (const handle of ok) removeQuietly(handle);
      settle({ kind: "browser-unavailable" });
      return;
    }
    handles.push(...ok);
    try {
      await ports.openBrowser(input.url);
    } catch {
      settle({ kind: "browser-unavailable" });
    }
  })();

  return {
    cancel() {
      if (!finished) finish();
    },
  };
}
