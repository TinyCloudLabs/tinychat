import { Navigate, useLocation } from "react-router-dom";

import { PATHS } from "../shell/routes";
import { useAppsFeedEnabled } from "../lib/appsFeedFeature";
import { LandingPage } from "./LandingPage";

// What `/` shows. The native mobile shell (Capacitor) IS the app, so it opens
// straight on Capture (TC-761); a signed-out user sees the sign-in surface there.
// The web opens Chat until the experimental Apps and Feed surfaces are enabled.
// The desktop app keeps the marketing landing page.
//
// `replace` keeps `/` out of history, so Android's back button minimises the
// app from Capture instead of bouncing through the redirect.
export function RootRoute({ nativeShell, homeShell = false }: { nativeShell: boolean; homeShell?: boolean }) {
  if (nativeShell) return <Navigate to={PATHS.capture} replace />;
  if (homeShell) return <HomeEntry />;
  return <LandingPage />;
}

/** `/` on the web: opt-in users can still use their synced Home choice. */
function HomeEntry() {
  const { search, hash } = useLocation();
  const enabled = useAppsFeedEnabled();
  return <Navigate to={{ pathname: enabled ? PATHS.feed : PATHS.chat, search, hash }} state={enabled ? { homeEntry: true } : undefined} replace />;
}

/** `/about`: the marketing landing page, kept reachable when web `/` opens the app. */
export function LandingRoute() {
  return <LandingPage />;
}
