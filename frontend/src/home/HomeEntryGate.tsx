import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PATHS } from "../shell/routes";
import type { FirstScreen } from "./firstScreenStore";

/**
 * The longest an ordinary entry waits for the saved first-screen choice. A slow
 * node can take far longer to answer; past this deadline Home opens on Feed and
 * a late answer never moves a user who is already looking at it.
 */
export const FIRST_SCREEN_WAIT_MS = 1500;

/**
 * Only an entry through `/` waits for the account preference, and only up to
 * FIRST_SCREEN_WAIT_MS; explicit links render at once. A choice of Apps that
 * arrives inside the window goes to Apps. A failed read, an unset or unreadable
 * value, a read that is still pending at the deadline: Feed, and never a later
 * redirect.
 */
export function HomeEntryGate({ load, children }: { load: () => Promise<FirstScreen>; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const entry = location.pathname === PATHS.feed &&
    (location.state as { homeEntry?: boolean } | null)?.homeEntry === true;
  const [released, setReleased] = useState(false);
  // One decision per gate: re-renders (a new `navigate` identity) never restart the read.
  const decided = useRef(false);
  const latest = useRef({ navigate, search: location.search, hash: location.hash });
  latest.current = { navigate, search: location.search, hash: location.hash };

  useEffect(() => {
    if (!entry || decided.current) return;
    let open = true;
    const settle = (screen: FirstScreen | null) => {
      if (!open) return;
      open = false;
      decided.current = true;
      clearTimeout(timer);
      if (screen === "apps") {
        const { navigate: go, search, hash } = latest.current;
        go({ pathname: PATHS.apps, search, hash }, { replace: true, state: null });
      } else {
        setReleased(true);
      }
    };
    const timer = setTimeout(() => settle(null), FIRST_SCREEN_WAIT_MS);
    try {
      load().then((screen) => settle(screen === "apps" ? "apps" : "feed"), () => settle(null));
    } catch {
      settle(null);
    }
    return () => {
      open = false;
      clearTimeout(timer);
    };
  }, [entry, load]);

  return entry && !released ? null : children;
}
