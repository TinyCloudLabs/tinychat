import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PATHS } from "../shell/routes";
import type { FirstScreen } from "./firstScreenStore";

/** Only an entry through `/` waits for the account preference; explicit links render at once. */
export function HomeEntryGate({ load, children }: { load: () => Promise<FirstScreen>; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const entry = location.pathname === PATHS.feed &&
    (location.state as { homeEntry?: boolean } | null)?.homeEntry === true;
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    void load().then((screen) => {
      if (cancelled) return;
      if (screen === "apps") {
        navigate({ pathname: PATHS.apps, search: location.search, hash: location.hash }, { replace: true, state: null });
      } else {
        setLoaded(true);
      }
    }).catch(() => {
      // A failed preference read keeps the default Feed, never blocks Home.
      if (!cancelled) setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [entry, load, location.search, location.hash, navigate]);

  return entry && !loaded ? null : children;
}
