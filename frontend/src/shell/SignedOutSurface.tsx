import type { ReactNode } from "react";

import { HomeWelcome } from "../home/HomeWelcome";
import type { AppState } from "../lib/appState";
import { appNameFor } from "../lib/homeSite";
import type { AppPlatform } from "../lib/platform";
import { BootSurface } from "./BootSurface";

// A visitor with no session sees the front page; restoring, offline and error states keep the boot screen,
// which carries the message and the retry, so a returning visitor never gets the front page there.
const frontPageStates: ReadonlySet<AppState> = new Set<AppState>(["unauthenticated", "connecting", "signing"]);

/**
 * What a visitor without a session sees, inside the page's one `<main>`: the
 * native sign-in screen when it is up, else on the Home site (TC-2387) the front
 * page with its sample cards, else the Exo sign-in screen. Restoring a session, being offline
 * and a failed restore always show the boot screen.
 */
export function SignedOutSurface(props: {
  homeSite: boolean;
  platform: AppPlatform;
  state: AppState;
  error: string | null;
  onAction: () => void;
  native?: ReactNode;
}) {
  const { homeSite, platform, state, error, onAction } = props;
  return (
    <main className="h-full overflow-y-auto pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
      {props.native ??
        (homeSite && platform === "web" && frontPageStates.has(state)
          ? <HomeWelcome state={state} error={error} onSignIn={onAction} />
          : <BootSurface state={state} error={error} onAction={onAction} home={platform === "web"} appName={appNameFor(homeSite)} />)}
    </main>
  );
}
