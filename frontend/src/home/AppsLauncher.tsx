// The TinyCloud apps launcher (One Apps): a grid of tiles, each opening an app
// and each pinnable to the navigation. Presentational; AppsPage feeds it the
// registry and the account's pins.
import { useEffect, useState, type ComponentProps } from "react";
import { Link } from "react-router-dom";
import { ExternalLinkIcon, PinIcon, PinOffIcon, type LucideIcon } from "lucide-react";

import { connectorsAriaLabel } from "@/chat/useBackgroundDrain";
import {
  APPS_LAUNCHER_TITLE,
  APPS_OPENS_NEW_TAB,
  APPS_PIN,
  APPS_PIN_HINT,
  APPS_UNPIN,
  appPinnedToast,
  appUnpinnedToast,
} from "@/lib/homeStrings";
import { cn } from "@/lib/utils";
import { openLinkInApp } from "@/feed/inAppLink";
import type { AppTarget } from "@/apps/registry";
import { NavBadge } from "@/shell/NavBadge";
import type { PinId } from "@/shell/navPins";
import { PAGE_COLUMN, PageHeader } from "@/shell/PageHeader";

export interface LauncherTile {
  /** What pinning the tile adds to the navigation. */
  pin: PinId;
  name: string;
  description?: string;
  icon: LucideIcon;
  /** Where the tile opens: One's route, or the app's own page in a new tab (the registry's appTarget). */
  target: AppTarget;
  /** Meetings waiting (Connectors): shown on the tile while the tile is not pinned. */
  pending?: number;
}

/** A new-tab target leaves One on the web; in the phone app it opens in the system's in-app browser (no delegation). */
function TileLink({ opens, children, ...rest }: { opens: AppTarget } & Omit<ComponentProps<"a">, "href" | "target">) {
  if (opens.kind === "newTab") {
    return (
      <a href={opens.url} target="_blank" rel="noopener noreferrer" onClick={(event) => openLinkInApp(opens.url, event.nativeEvent, { sheet: false })} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link to={opens.path} {...rest}>
      {children}
    </Link>
  );
}

const TOAST_MS = 2400;

export interface AppsLauncherProps {
  tiles: readonly LauncherTile[];
  pins: readonly PinId[];
  /** Pinning needs a signed-in account to keep the pins under. */
  canPin: boolean;
  onPin: (id: PinId) => void;
  onUnpin: (id: PinId) => void;
}

export function AppsLauncher({ tiles, pins, canPin, onPin, onUnpin }: AppsLauncherProps) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <div className="relative h-full overflow-y-auto" data-scroll-root>
      <PageHeader title={APPS_LAUNCHER_TITLE} className={PAGE_COLUMN} />
      <div className={`${PAGE_COLUMN} flex flex-col gap-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]`}>
        {canPin && pins.length === 0 ? <p className="text-body text-muted-foreground">{APPS_PIN_HINT}</p> : null}
        <ul aria-label={APPS_LAUNCHER_TITLE} className="grid grid-cols-1 gap-3 medium:grid-cols-2">
          {tiles.map((tile) => {
            const pinned = pins.includes(tile.pin);
            const Icon = tile.icon;
            return (
              <li key={tile.pin} className="flex flex-col rounded-lg border bg-card">
                <TileLink
                  opens={tile.target}
                  aria-label={tile.pending && !pinned ? connectorsAriaLabel(tile.pending) : undefined}
                  className="tap-transparent relative flex min-h-11 flex-1 flex-col gap-1 rounded-t-lg p-3 hover:bg-surface-2"
                >
                  <span className="flex items-center gap-2 text-body font-semibold text-foreground">
                    <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                    {tile.name}
                    {tile.target.kind === "newTab" ? <ExternalLinkIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}
                  </span>
                  {tile.description ? <span className="text-body text-muted-foreground">{tile.description}</span> : null}
                  {tile.target.kind === "newTab" ? <span className="sr-only">({APPS_OPENS_NEW_TAB})</span> : null}
                  {pinned ? null : <NavBadge count={tile.pending} className="right-3 top-3" />}
                </TileLink>
                {canPin ? (
                  <button
                    type="button"
                    aria-pressed={pinned}
                    onClick={() => {
                      if (pinned) {
                        onUnpin(tile.pin);
                        setMessage(appUnpinnedToast(tile.name));
                      } else {
                        onPin(tile.pin);
                        setMessage(appPinnedToast(tile.name));
                      }
                    }}
                    className={cn(
                      "tap-transparent flex min-h-11 items-center gap-2 rounded-b-lg border-t px-3 text-label font-medium fine:min-h-10",
                      "text-primary hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    {pinned ? <PinOffIcon aria-hidden className="size-4" /> : <PinIcon aria-hidden className="size-4" />}
                    {pinned ? APPS_UNPIN : APPS_PIN}
                    <span className="sr-only">{tile.name}</span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      <div role="status" className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tc-bottom-chrome,0px)+1rem)] flex justify-center px-4">
        {message === null ? null : (
          <span className="rounded-full bg-foreground px-4 py-2 text-label font-medium text-background shadow-lg">{message}</span>
        )}
      </div>
    </div>
  );
}
