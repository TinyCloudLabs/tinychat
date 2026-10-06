import { Navigate } from "react-router-dom";

import { PATHS } from "../shell/routes";
import { LandingPage } from "./LandingPage";

// What `/` shows. The web and the desktop app open on the marketing landing
// page. The native mobile shell (Capacitor) IS the app, so it opens straight
// on Capture (TC-761); a signed-out user sees the sign-in surface there.
//
// `replace` keeps `/` out of history, so Android's back button minimises the
// app from Capture instead of bouncing through the redirect.
export function RootRoute({ nativeShell }: { nativeShell: boolean }) {
  if (nativeShell) return <Navigate to={PATHS.capture} replace />;
  return <LandingPage />;
}
