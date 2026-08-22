import type { SignOutAcknowledgement } from "@openkey/sdk";

export interface OpenKeySignOutClient {
  signOut(): Promise<SignOutAcknowledgement>;
}

/**
 * Prefer the OpenKey client that authenticated this page. A restored TinyChat
 * session has no such in-memory client, so construct one lazily and let the
 * OpenKey-owned widget sign out its browser session instead.
 */
export function signOutOpenKeySession(
  current: OpenKeySignOutClient | null,
  createFallback: () => OpenKeySignOutClient,
): Promise<SignOutAcknowledgement> {
  return (current ?? createFallback()).signOut();
}
