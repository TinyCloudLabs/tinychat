import { Navigate } from "react-router-dom";

import { LandingPage } from "./LandingPage";

// What `/` shows. The web and the desktop app open on the marketing landing
// page. The native mobile shell (Capacitor) IS the app, so it opens straight
// on the chat surface; a signed-out user sees the sign-in surface there.
//
// `replace` keeps `/` out of history, so Android's back button exits the app
// from the chat surface instead of bouncing through the redirect.
export const APP_HOME_PATH = "/chat";

export function RootRoute({ nativeShell }: { nativeShell: boolean }) {
  if (nativeShell) return <Navigate to={APP_HOME_PATH} replace />;
  return <LandingPage />;
}
