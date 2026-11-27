import type { SignOutAcknowledgement } from "@openkey/sdk";
import { logNativeOpenKeyError } from "./openkeyNative";

/** The slice of `OpenKey.signOut` used here. `onProgress` is the SDK's: 'ready' when the sign-out sheet is showing, 'confirmed' when the owner confirms it. */
export interface OpenKeySignOutClient {
  signOut(opts?: { onProgress?: (progress: "ready" | "confirmed") => void }): Promise<SignOutAcknowledgement>;
}

export type OpenKeySignOutOutcome =
  | { status: "revoked" }
  | { status: "cancelled" }
  | { status: "remote-unavailable" }
  | { status: "unverified" };

/** The transport bound: from the call to the sheet being ready, and from the owner's confirmation to OpenKey's answer. */
export const OPENKEY_SIGN_OUT_TIMEOUT_MS = 5_000;
/** The owner's own wait between a ready sheet and their confirmation. A sheet left open this long settles as unverified. */
export const OPENKEY_SIGN_OUT_OWNER_WAIT_MS = 120_000;

/**
 * `revoked: false` means the widget could not prove a revocation: it also answers that when it
 * found no token to revoke, and the SDK cannot tell that from a failed revoke or an unreachable
 * OpenKey. Every outcome other than `revoked` therefore means "a live session may remain".
 *
 * The sheet waits for the owner's click, so one fixed bound on the whole call would expire before a
 * person confirms. The bound follows the SDK's progress instead: `timeoutMs` runs until the sheet is
 * ready, the owner has `ownerWaitMs` to confirm, and `timeoutMs` runs again from the confirmation to
 * OpenKey's answer. A sheet that never reports ready, an owner who never confirms, and a confirmation
 * OpenKey never answers each settle as unverified; the owner closing the sheet is `cancelled`.
 *
 * Prefer the OpenKey client that authenticated this page. A restored TinyChat
 * session has no such in-memory client, so construct one lazily and let the
 * OpenKey-owned widget sign out its browser session instead.
 */
export async function signOutOpenKeySession(
  current: OpenKeySignOutClient | null,
  createFallback: () => OpenKeySignOutClient,
  timeoutMs = OPENKEY_SIGN_OUT_TIMEOUT_MS,
  ownerWaitMs = OPENKEY_SIGN_OUT_OWNER_WAIT_MS,
): Promise<OpenKeySignOutOutcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let phase: "opening" | "owner" | "answering" = "opening";
  let settled = false;
  let expire!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    expire = () => reject(new Error("OpenKey sign-out timed out"));
  });
  const arm = (ms: number) => {
    clearTimeout(timeout);
    timeout = setTimeout(expire, ms);
  };
  arm(timeoutMs);
  const onProgress = (progress: "ready" | "confirmed") => {
    if (settled) return;
    if (progress === "ready" && phase === "opening") {
      phase = "owner";
      arm(ownerWaitMs);
    } else if (progress === "confirmed" && phase === "owner") {
      phase = "answering";
      arm(timeoutMs);
    }
  };
  try {
    const acknowledgement = await Promise.race([
      Promise.resolve().then(() => (current ?? createFallback()).signOut({ onProgress })),
      deadline,
    ]);
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
  } finally {
    settled = true;
    clearTimeout(timeout);
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
