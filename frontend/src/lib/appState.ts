// The app's authentication state. It lives outside App.tsx so Settings and the
// routing guard can use it without importing the whole app shell.

export type AppState =
  | "booting"
  | "unauthenticated"
  | "connecting"
  | "signing"
  | "ready"
  | "recoverableError"
  // A persisted session is HELD but couldn't be restored because the network
  // (or the backend) is unreachable. Not signed out: "Try again" and the
  // browser's `online` event re-run the restore, never OpenKey (TC-514).
  | "offline";

export function stateLabel(state: AppState): string {
  const labels: Record<AppState, string> = {
    booting: "Starting",
    unauthenticated: "Signed out",
    connecting: "Connecting",
    signing: "Signing in",
    ready: "Connected",
    recoverableError: "Needs attention",
    offline: "Offline",
  };
  return labels[state];
}
