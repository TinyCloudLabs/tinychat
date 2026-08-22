import type { SignOutAcknowledgement } from "@openkey/sdk";

export interface OpenKeySignOutClient {
  signOut(): Promise<SignOutAcknowledgement>;
}

export type OpenKeySignOutOutcome =
  | { status: "revoked" }
  | { status: "cancelled" }
  | { status: "unverified"; reason: string | null };

/**
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
      : { status: "unverified", reason: null };
  } catch (error) {
    if (openKeyErrorCode(error) === "USER_CANCELLED") {
      return { status: "cancelled" };
    }
    return { status: "unverified", reason: openKeyErrorMessage(error) };
  }
}

function openKeyErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;
  return typeof error.code === "string" ? error.code : null;
}

function openKeyErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null || !("message" in error))
    return null;
  return typeof error.message === "string" ? error.message : null;
}
