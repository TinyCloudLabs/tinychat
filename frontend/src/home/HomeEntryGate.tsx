import { useEffect, type ReactNode } from "react";
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
 * One decision per entry, shared by every mount of the gate for that entry (a
 * StrictMode double mount or a remount while the read is pending joins it
 * instead of starting a second read and a second deadline). Keyed by the
 * entry's location key.
 */
const decisions = new Map<string, Promise<FirstScreen>>();

function decide(key: string, load: () => Promise<FirstScreen>): Promise<FirstScreen> {
  let decision = decisions.get(key);
  if (!decision) {
    decision = new Promise<FirstScreen>((resolve) => {
      const timer = setTimeout(() => resolve("feed"), FIRST_SCREEN_WAIT_MS);
      const settle = (screen: FirstScreen) => {
        clearTimeout(timer);
        resolve(screen);
      };
      try {
        load().then((screen) => settle(screen === "apps" ? "apps" : "feed"), () => settle("feed"));
      } catch {
        settle("feed");
      }
    });
    decisions.set(key, decision);
  }
  return decision;
}

/**
 * Only an entry through `/` waits for the account preference, and only up to
 * FIRST_SCREEN_WAIT_MS; explicit links render at once and never read it. An
 * Apps choice that arrives inside the window goes to Apps. A failed read, an
 * unset or unreadable value, or a read still pending at the deadline: Feed.
 *
 * The decision ends the entry: the gate replaces the location with one that no
 * longer carries the `homeEntry` marker. A remount after that renders at once,
 * never reads again, and never redirects on a late answer.
 */
export function HomeEntryGate({ load, children }: { load: () => Promise<FirstScreen>; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const entry = location.pathname === PATHS.feed &&
    (location.state as { homeEntry?: boolean } | null)?.homeEntry === true;
  const { key, search, hash } = location;

  useEffect(() => {
    if (!entry) return;
    let current = true;
    void decide(key, load).then((screen) => {
      if (!current) return;
      decisions.delete(key);
      navigate({ pathname: screen === "apps" ? PATHS.apps : PATHS.feed, search, hash }, { replace: true, state: null });
    });
    return () => { current = false; };
  }, [entry, key, load, search, hash, navigate]);

  return entry ? null : children;
}
