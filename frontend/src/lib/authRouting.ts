// Has authentication SETTLED without an authorized session?
//
// The private surfaces (/chat/settings, /chat/connectors and its nested
// Library route, and the legacy /chat/meetings forward) are real addresses:
// they get shared, bookmarked and reloaded. A cold load with a valid persisted
// session starts in `booting` and only reaches `ready` once
// restoreTinyCloudWebSession resolves — so "not ready" is NOT "signed out".
// Redirecting on `!isReady` throws the requested pathname away mid-restore and
// the user lands on /chat instead of the page they asked for.
//
// Only the two states that render the sign-in button are terminal answers.
// Everything else is still deciding, and a still-deciding app must keep the
// address it was given.

import type { AppState } from "../App";

// A total map rather than a comparison chain, so adding an AppState is a type
// error here until it is classified — the same shape as `stateLabel` in App.
const SETTLED_SIGNED_OUT: Record<AppState, boolean> = {
  // Restoring a persisted session — the cold-reload window.
  booting: false,
  // The interactive sign-in handshake.
  connecting: false,
  signing: false,
  // Authorized.
  ready: false,
  // No/expired session, or a restore that failed and cleared it.
  unauthenticated: true,
  // Sign-in or restore errored out; the session store is cleared and the
  // header offers "Try again". Settled, and settled signed out.
  recoverableError: true,
};

export function isAuthSettledSignedOut(state: AppState): boolean {
  return SETTLED_SIGNED_OUT[state];
}
