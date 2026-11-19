import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { PRODUCT_PAGE_URL } from "../lib/homeSite";
import { PATHS } from "../shell/routes";

// What `/` shows on every platform (web, desktop, iOS and Android): TinyCloud
// Home's first screen. It goes to Feed marked as a Home entry, and HomeEntryGate
// (home/HomeEntryGate.tsx) moves it to Apps when the user chose Apps in
// Settings; signed out, the sign-in surface renders in place and the entry is
// decided once sign-in finishes.
//
// `replace` keeps `/` out of history, so Android's back button minimises the
// app from the first screen instead of bouncing through the redirect.
export function RootRoute() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: PATHS.feed, search, hash }} state={{ homeEntry: true }} replace />;
}

const leaveFor = (url: string) => window.location.replace(url);

/** `/about`: the old in-app landing page is gone; the address keeps working by moving to the product page. */
export function AboutRedirect({ go = leaveFor }: { go?: (url: string) => void }) {
  useEffect(() => { go(PRODUCT_PAGE_URL); }, [go]);
  return <a href={PRODUCT_PAGE_URL}>Opening the product page</a>;
}
