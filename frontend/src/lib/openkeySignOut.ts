import type { SignOutAcknowledgement } from "@openkey/sdk";
import { logNativeOpenKeyError } from "./openkeyNative";

export interface OpenKeySignOutClient {
  signOut(): Promise<SignOutAcknowledgement>;
}

export type OpenKeySignOutOutcome =
  | { status: "revoked" }
  | { status: "no-session" }
  | { status: "cancelled" }
  | { status: "remote-unavailable" }
  | { status: "unverified" };

export interface OpenKeySignOutContext {
  /** This app run signed in with the client being used, so the widget holds that session's token. */
  signedInThisRun: boolean;
  /**
   * OpenKey's embedded widget keeps its session token only in per-run iframe storage here
   * (a cross-site iframe in the phone app gets no cookie), so a session from an earlier run is gone.
   */
  sessionOnlyInRun: boolean;
}

/**
 * The widget answers `revoked: false` for "no token to revoke", "revoke failed" and "could not reach
 * OpenKey" alike, so the answer alone cannot say whether a live session remains. Only one case is
 * knowable here: a restored session in an app whose widget session lives only in the current run
 * has nothing left to revoke.
 *
 * Prefer the OpenKey client that authenticated this page. A restored TinyChat
 * session has no such in-memory client, so construct one lazily and let the
 * OpenKey-owned widget sign out its browser session instead.
 */
export async function signOutOpenKeySession(
  current: OpenKeySignOutClient | null,
  createFallback: () => OpenKeySignOutClient,
  context: OpenKeySignOutContext = { signedInThisRun: true, sessionOnlyInRun: false },
): Promise<OpenKeySignOutOutcome> {
  try {
    const acknowledgement = await (current ?? createFallback()).signOut();
    if (acknowledgement.revoked) return { status: "revoked" };
    return !context.signedInThisRun && context.sessionOnlyInRun
      ? { status: "no-session" }
      : { status: "unverified" };
  } catch (error) {
    if (openKeyErrorCode(error) === "POPUP_BLOCKED" && openKeyErrorReason(error) === "embedded-webview") {
      console.warn("[OpenKey] sign-out sheet could not open in this WebView (POPUP_BLOCKED, embedded-webview); the OpenKey session was not revoked.");
      return { status: "remote-unavailable" };
    }
    if (openKeyErrorCode(error) === "USER_CANCELLED") {
      return { status: "cancelled" };
    }
    logNativeOpenKeyError("OpenKey sign-out", error);
    return { status: "unverified" };
  }
}

function openKeyErrorReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("reason" in error)) return null;
  return typeof error.reason === "string" ? error.reason : null;
}

function openKeyErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;
  return typeof error.code === "string" ? error.code : null;
}
