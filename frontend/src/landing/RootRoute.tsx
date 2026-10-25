import { Navigate, useLocation } from "react-router-dom";

import { PATHS } from "../shell/routes";
import { LandingPage } from "./LandingPage";

// What `/` shows. The native mobile shell (Capacitor) IS the app, so it opens
// straight on Capture (TC-761); a signed-out user sees the sign-in surface there.
// The web is TinyCloud Home (TC-2040): `/` opens its default destination, Feed.
// The desktop app keeps the marketing landing page.
//
// `replace` keeps `/` out of history, so Android's back button minimises the
// app from Capture instead of bouncing through the redirect.
export function RootRoute({ nativeShell, homeShell = false }: { nativeShell: boolean; homeShell?: boolean }) {
  if (nativeShell) return <Navigate to={PATHS.capture} replace />;
  if (homeShell) return <HomeEntry />;
  return <LandingPage />;
}

/** `/` on the web: Feed, carrying any query and fragment across (a `#share=` is never dropped). */
function HomeEntry() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: PATHS.feed, search, hash }} replace />;
}

/** `/about`: the marketing landing page, kept reachable now that web `/` opens Feed. */
export function LandingRoute() {
  return <LandingPage />;
}
