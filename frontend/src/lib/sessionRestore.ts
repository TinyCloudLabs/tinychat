import type { SessionStore } from "@tinyboilerplate/client";

/**
 * TC-514 — restoring a persisted session must survive launching offline.
 *
 * On boot App restores two sessions that both live on this device: the backend
 * Bearer session (`SessionStore`) and the TinyCloud session
 * (`tinycloud:session:<address>`, read by restoreTinyCloudWebSession). The
 * restore used to clear the Bearer session on ANY failure — including the
 * network error from fetching /api/manifest — so opening the app on a phone
 * without signal signed the user out although nothing about the session was
 * wrong, and "Try again" then ran a full OpenKey sign-in.
 *
 * The rule here: only a verdict ABOUT THE SESSION may end it. Failing to REACH
 * something the restore needs (the manifest, a TinyCloud host) says nothing
 * about the session, so both sessions are kept and the caller gets
 * `unavailable` to retry from. The SDK's definitive statuses (expired, corrupt,
 * missing, stale …) still clear exactly as before.
 *
 * DOM-free and dependency-injected (the billingConfigPolicy idiom) so the
 * classification and the retry path are unit-asserted, not eyeballed.
 */

/** The SessionStore surface the restore reads and, on a verdict, clears. */
export type RestoreSessionStore = Pick<
  SessionStore,
  "hasSession" | "isExpired" | "getAddress" | "getToken" | "clear"
>;

/** What restoreTinyCloudWebSession resolves with (status is the SDK's). */
export interface RestoreAttempt<T> {
  status: string;
  tcw: T | null;
  error?: Error;
}

export interface RestoreDeps<M, T> {
  /** Durable capture handoff before an auth verdict clears the local token. */
  beforeClear?: () => Promise<void>;
  /**
   * Load the app manifest. ANY rejection counts as unreachable: the manifest is
   * public app config, so failing to get it — network, 5xx, a backend that is
   * still starting — is never an answer about this user's session.
   */
  loadManifest: () => Promise<M>;
  /** restoreTinyCloudWebSession, bound to the app's host + restore config. */
  restore: (address: string, manifest: M) => Promise<RestoreAttempt<T>>;
  /** True when the browser reports no connectivity (`navigator.onLine`). */
  isOffline: () => boolean;
}

export type RestoreOutcome<T> =
  | { kind: "restored"; address: string; tcw: T }
  /** No session to restore, or the session itself was refused (cleared). */
  | { kind: "signedOut" }
  /** Couldn't reach what restore needs. BOTH sessions are kept; retry later. */
  | { kind: "unavailable"; message: string }
  /** An unexpected, non-network failure. Cleared, as before TC-514. */
  | { kind: "failed"; message: string };

export type RestoreFailureKind = "transient" | "auth";

const OFFLINE_MESSAGE = "You're offline. Exo will reconnect when you're back online.";
const UNREACHABLE_MESSAGE = "Can't reach Exo right now. You're still signed in.";

export function restoreUnavailableMessage(offline: boolean): string {
  return offline ? OFFLINE_MESSAGE : UNREACHABLE_MESSAGE;
}

export function browserIsOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

// What a failed fetch looks like per engine: Chromium/Android WebView, Firefox,
// Safari/WKWebView, React Native, undici (Node/Bun).
const NETWORK_FAILURE =
  /failed to fetch|networkerror|load failed|network request failed|fetch failed|timed? ?out/i;

/**
 * Does this error mean "couldn't reach the server" rather than "the server (or
 * the stored session) said no"? Network-level fetch failures, aborts/timeouts,
 * and 408/429/5xx responses qualify. Follows `cause` a few links, because SDK
 * layers wrap the underlying fetch error.
 */
export function isTransientRestoreError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current != null; depth++) {
    if (typeof current === "object") {
      const { name, message, status } = current as {
        name?: unknown;
        message?: unknown;
        status?: unknown;
      };
      if (name === "AbortError" || name === "TimeoutError") return true;
      if (typeof status === "number" && (status >= 500 || status === 408 || status === 429)) {
        return true;
      }
      if (typeof message === "string") {
        if (NETWORK_FAILURE.test(message)) return true;
        if (/\bHTTP (5\d\d|408|429)\b/.test(message)) return true;
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      return typeof current === "string" && NETWORK_FAILURE.test(current);
    }
  }
  return false;
}

/**
 * Classify a restore that did not come back `restored`.
 *
 * Every status except `restore-failed` is a verdict the SDK reached by reading
 * the stored session itself (missing / expired / corrupt / stale /
 * storage-unavailable / disabled) — no network involved, so retrying cannot
 * change it: `auth`, clear it. `restore-failed` wraps whatever threw while
 * rebuilding the session, which includes the host-registry lookup; that is
 * `transient` when the error is a network one, or when the device is offline
 * (an offline device cannot tell the two apart, and keeping the session until
 * it is back online costs one more restore, while clearing it costs a sign-in).
 */
export function classifyRestoreFailure(
  result: { status: string; error?: unknown },
  offline: boolean,
): RestoreFailureKind {
  if (result.status !== "restore-failed") return "auth";
  return offline || isTransientRestoreError(result.error) ? "transient" : "auth";
}

/**
 * Restore the persisted session, clearing the Bearer session ONLY on a verdict
 * about it. Safe to call again after `unavailable` — that is the retry path.
 */
export async function restorePersistedSession<M, T>(
  sessionStore: RestoreSessionStore,
  deps: RestoreDeps<M, T>,
): Promise<RestoreOutcome<T>> {
  if (!sessionStore.hasSession() || sessionStore.isExpired()) {
    if (sessionStore.hasSession()) await deps.beforeClear?.();
    return { kind: "signedOut" };
  }
  const address = sessionStore.getAddress();
  const token = sessionStore.getToken();
  if (!address || !token) {
    await deps.beforeClear?.();
    sessionStore.clear();
    return { kind: "signedOut" };
  }
  const unavailable = (): RestoreOutcome<T> => ({
    kind: "unavailable",
    message: restoreUnavailableMessage(deps.isOffline()),
  });

  let manifest: M;
  try {
    manifest = await deps.loadManifest();
  } catch {
    return unavailable();
  }

  let restored: RestoreAttempt<T>;
  try {
    restored = await deps.restore(address, manifest);
  } catch (caught) {
    // restoreTinyCloudWebSession reports its failures as a status; reaching
    // here means something outside it threw. Same split as a status would get.
    if (classifyRestoreFailure({ status: "restore-failed", error: caught }, deps.isOffline()) === "transient") {
      return unavailable();
    }
    await deps.beforeClear?.();
    sessionStore.clear();
    return { kind: "failed", message: caught instanceof Error ? caught.message : "Unexpected error" };
  }

  if (restored.status === "restored" && restored.tcw) {
    return { kind: "restored", address, tcw: restored.tcw };
  }
  if (classifyRestoreFailure(restored, deps.isOffline()) === "transient") {
    return unavailable();
  }
  await deps.beforeClear?.();
  sessionStore.clear();
  return { kind: "signedOut" };
}
