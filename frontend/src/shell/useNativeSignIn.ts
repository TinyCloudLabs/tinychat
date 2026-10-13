// How App opens Exo's own sign-in screen on iOS and Android (TC-941): who asks
// for it, where "Not now" goes back to, and the one entry that must not use it.
import { useCallback, useEffect, useState } from "react";

import type { AppState } from "../lib/appState";
import type { NativeSignInHints } from "../lib/openkeyNative";
import { showsNativeSignIn } from "../lib/authRouting";

export function useNativeSignIn(options: {
  native: boolean;
  state: AppState;
  localHome: boolean;
  signIn: (hints?: NativeSignInHints) => Promise<void>;
  restoreSession: () => void | Promise<void>;
  /** Drop the sign-in's error and settle signed out. */
  settleSignedOut: () => void;
}) {
  const { native, state, localHome, signIn, restoreSession, settleSignedOut } = options;
  // Where the screen was opened from outlives the state a failed sign-in moves
  // to, so the way back to the local home is still there after an error.
  const [request, setRequest] = useState<{ fromLocalHome: boolean } | null>(null);
  useEffect(() => {
    if (state === "ready") setRequest(null);
  }, [state]);

  const openScreen = useCallback(() => setRequest({ fromLocalHome: localHome }), [localHome]);
  const close = useCallback(() => {
    setRequest(null);
    settleSignedOut();
  }, [settleSignedOut]);

  return {
    // "Sign in to sync" and the recorder's sign-in open the screen on native.
    authAction: state === "offline" ? restoreSession : native ? openScreen : signIn,
    // The microphone recovery covers every screen, so it starts the sign-in itself, with no hints.
    micRecoveryContinue: state === "offline" ? restoreSession : () => signIn(),
    screenShown: showsNativeSignIn({ native, state, localHome, requested: request !== null }),
    onClose: request?.fromLocalHome ? close : undefined,
  };
}
