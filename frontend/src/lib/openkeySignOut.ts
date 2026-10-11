import type { SignOutAcknowledgement } from "@openkey/sdk";
import { logNativeOpenKeyError } from "./openkeyNative";

export interface OpenKeySignOutClient {
  signOut(): Promise<SignOutAcknowledgement>;
}

export type OpenKeySignOutOutcome =
  | { status: "revoked" }
  | { status: "cancelled" }
  | { status: "remote-unavailable" }
  | { status: "unverified" };

/**
 * `revoked: false` means the widget could not prove a revocation: it also answers that when it
 * found no token to revoke, and the SDK cannot tell that from a failed revoke or an unreachable
 * OpenKey. Every outcome other than `revoked` therefore means "a live session may remain".
 *
 * Prefer the OpenKey client that authenticated this page. A restored TinyChat
 * session has no such in-memory client, so construct one lazily and let the
 * OpenKey-owned widget sign out its browser session instead.
 */
export async function signOutOpenKeySession(
  current: OpenKeySignOutClient | null,
  createFallback: () => OpenKeySignOutClient,
): Promise<OpenKeySignOutOutcome> {
  try {
    const acknowledgement = await (current ?? createFallback()).signOut();
    return acknowledgement.revoked
      ? { status: "revoked" }
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
