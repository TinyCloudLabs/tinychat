import { useState, useSyncExternalStore, type ReactNode } from "react";
import { DownloadIcon, RefreshCwIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/homeSite";
import { useSignedIn } from "@/lib/signedIn";
import { applyUpdate, getPwaState, promptInstall, subscribePwa } from "@/lib/pwa";
import { getDesktopUpdate, restartToUpdate, subscribeDesktopUpdate } from "@/lib/desktopUpdate";

const INSTALL_DISMISSED_KEY = "xyz.tinycloud.tinychat:pwa-install-dismissed";
/** "Not now" hides the install offer for this long. */
const INSTALL_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

function installSnoozed(): boolean {
  try {
    const at = Number(window.localStorage.getItem(INSTALL_DISMISSED_KEY));
    return Number.isFinite(at) && Date.now() - at < INSTALL_SNOOZE_MS;
  } catch {
    return false;
  }
}

/** No install offer until the visitor has signed in. */
export function installOffered(input: { canInstall: boolean; installDismissed: boolean; signedIn: boolean }): boolean {
  return input.canInstall && !input.installDismissed && input.signedIn;
}

/**
 * The app's update and install prompts, one at a time: the desktop app's "Restart to update" (lib/desktopUpdate.ts,
 * offered only while no recording is in progress), the PWA's "New version available — Reload", and, on Chromium only,
 * "Install Exo". The PWA store never flips in the native shells, on iOS or once installed; the desktop offer exists
 * only in the desktop app.
 */
export function PwaPrompts() {
  const { updateReady, canInstall } = useSyncExternalStore(subscribePwa, getPwaState, getPwaState);
  const desktopUpdate = useSyncExternalStore(subscribeDesktopUpdate, getDesktopUpdate, getDesktopUpdate);
  const [desktopUpdateDismissed, setDesktopUpdateDismissed] = useState<string | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [installDismissed, setInstallDismissed] = useState(installSnoozed);
  const signedIn = useSignedIn();

  // "Later" hides this version's offer for this session; a newer download offers again.
  if (desktopUpdate && desktopUpdate.version !== desktopUpdateDismissed) {
    return (
      <PwaToast>
        <span className="min-w-0 flex-1">
          {APP_NAME} {desktopUpdate.version} is ready.
        </span>
        <Button size="sm" onClick={() => void restartToUpdate()}>
          <RefreshCwIcon />
          Restart to update
        </Button>
        <DismissButton label="Later" onClick={() => setDesktopUpdateDismissed(desktopUpdate.version)} />
      </PwaToast>
    );
  }

  if (updateReady && !updateDismissed) {
    return (
      <PwaToast>
        <span className="min-w-0 flex-1">New version of {APP_NAME} available.</span>
        <Button size="sm" onClick={applyUpdate}>
          <RefreshCwIcon />
          Reload
        </Button>
        <DismissButton label="Later" onClick={() => setUpdateDismissed(true)} />
      </PwaToast>
    );
  }

  if (installOffered({ canInstall, installDismissed, signedIn })) {
    return (
      <PwaToast>
        <span className="min-w-0 flex-1">Install {APP_NAME} as an app.</span>
        <Button size="sm" onClick={() => void promptInstall()}>
          <DownloadIcon />
          Install
        </Button>
        <DismissButton
          label="Not now"
          onClick={() => {
            try {
              window.localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now()));
            } catch {
              // Storage unavailable: hidden for this page only.
            }
            setInstallDismissed(true);
          }}
        />
      </PwaToast>
    );
  }

  return null;
}

function PwaToast({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tc-bottom-chrome)+8rem)] z-50 flex justify-center px-4 md:justify-end wide:bottom-[calc(var(--tc-bottom-chrome)+1rem)]"
    >
      <div className="pointer-events-auto flex w-full max-w-sm items-center gap-2 rounded-xl border bg-background py-2 pl-4 pr-2 text-sm text-foreground shadow-lg">
        {children}
      </div>
    </div>
  );
}

function DismissButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon" className="size-8" aria-label={label} title={label} onClick={onClick}>
      <XIcon />
    </Button>
  );
}
