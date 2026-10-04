import { useState, useSyncExternalStore, type ReactNode } from "react";
import { DownloadIcon, RefreshCwIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { applyUpdate, getPwaState, promptInstall, subscribePwa } from "@/lib/pwa";

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

/**
 * The PWA's two prompts, one at a time: "New version available — Reload"
 * (always wins) and, on Chromium only, "Install Exo". Renders nothing in the
 * native shells, on iOS and once installed: there the store never flips.
 */
export function PwaPrompts() {
  const { updateReady, canInstall } = useSyncExternalStore(subscribePwa, getPwaState, getPwaState);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [installDismissed, setInstallDismissed] = useState(installSnoozed);

  if (updateReady && !updateDismissed) {
    return (
      <PwaToast>
        <span className="min-w-0 flex-1">New version of Exo available.</span>
        <Button size="sm" onClick={applyUpdate}>
          <RefreshCwIcon />
          Reload
        </Button>
        <DismissButton label="Later" onClick={() => setUpdateDismissed(true)} />
      </PwaToast>
    );
  }

  if (canInstall && !installDismissed) {
    return (
      <PwaToast>
        <span className="min-w-0 flex-1">Install Exo as an app.</span>
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
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-50 flex justify-center px-4 md:bottom-[calc(env(safe-area-inset-bottom)+1rem)] md:justify-end"
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
