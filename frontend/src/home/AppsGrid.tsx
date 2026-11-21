// One's new navigation (ONE_NAV_ENABLED): the TinyCloud apps as a grid of app icons, three across, each opening its
// app's screen in One, then Add an app. A pinned app carries a small pin mark; pinning itself happens in the open app's
// bar (apps/AppBar.tsx). Presentational; AppsPage feeds it the registry and the account's pins.
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { PinIcon, PlusIcon } from "lucide-react";

import { AppTileIcon, type GlyphId } from "@/apps/icons";
import { ADD_APP_TITLE } from "@/apps/strings";
import { connectorsAriaLabel } from "@/chat/useBackgroundDrain";
import { APPS_LAUNCHER_TITLE, APPS_PIN_HINT } from "@/lib/homeStrings";
import { NavBadge } from "@/shell/NavBadge";
import type { PinId } from "@/shell/navPins";
import { PAGE_COLUMN, PageHeader } from "@/shell/PageHeader";
import { PATHS } from "@/shell/routes";

export interface GridTile {
  /** What pins the app to the navigation. */
  pin: PinId;
  name: string;
  /** The short line under the name, from 640 px. */
  caption: string;
  glyph: GlyphId;
  /** The app's screen in One (the registry's appRoute). */
  path: string;
  /** Meetings waiting (Connectors): shown on the tile while the tile is not pinned. */
  pending?: number;
}

const TILE =
  "tc-launcher-tile tap-transparent relative flex w-full min-w-0 flex-col items-center gap-2 rounded-lg px-1 py-2 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-0 sm:px-3 sm:pb-[18px] sm:pt-[22px]";
const ICON_SIZE = "size-[72px] sm:mb-3.5 sm:size-[88px]";
const NAME = "max-w-full truncate text-[0.8125rem] font-semibold leading-[1.125rem] text-foreground sm:text-headline";

export interface AppsGridProps {
  tiles: readonly GridTile[];
  pins: readonly PinId[];
  /** Pinning needs a signed-in account to keep the pins under. */
  canPin: boolean;
}

export function AppsGrid({ tiles, pins, canPin }: AppsGridProps) {
  return (
    <div className="relative h-full overflow-y-auto" data-scroll-root>
      <PageHeader title={APPS_LAUNCHER_TITLE} className={PAGE_COLUMN} />
      <div className={`${PAGE_COLUMN} flex flex-col gap-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]`}>
        {canPin && pins.length === 0 ? <p className="text-body text-muted-foreground">{APPS_PIN_HINT}</p> : null}
        <ul aria-label={APPS_LAUNCHER_TITLE} className="tc-launcher-grid grid grid-cols-3 gap-x-1 gap-y-[22px] sm:max-w-[40rem] sm:gap-2">
          {tiles.map((tile, index) => {
            const pinned = pins.includes(tile.pin);
            return (
              <li key={tile.pin} style={{ "--i": index } as CSSProperties} className="flex min-w-0">
                <Link
                  to={tile.path}
                  aria-label={tile.pending && !pinned ? connectorsAriaLabel(tile.pending) : undefined}
                  data-pinned={pinned ? "" : undefined}
                  className={TILE}
                >
                  <span className="relative">
                    <AppTileIcon id={tile.glyph} className={ICON_SIZE} />
                    {pinned ? (
                      <span aria-hidden="true" className="absolute -right-2 -top-1.5 grid size-[22px] place-items-center rounded-full border border-border bg-background text-foreground sm:-top-2">
                        <PinIcon className="size-3" />
                      </span>
                    ) : (
                      <NavBadge count={tile.pending} className="-right-2 -top-2" />
                    )}
                  </span>
                  <span className={NAME}>{tile.name}</span>
                  <span className="hidden max-w-full text-meta text-muted-foreground sm:mt-0.5 sm:block">{tile.caption}</span>
                </Link>
              </li>
            );
          })}
          {/* An action, not an app: an outlined square, never pinned. */}
          <li style={{ "--i": tiles.length } as CSSProperties} className="flex min-w-0">
            <Link to={PATHS.addApp} className={TILE}>
              <span aria-hidden="true" className={`${ICON_SIZE} grid place-items-center rounded-[27%] border-2 border-dashed border-muted-foreground/45 text-muted-foreground`}>
                <PlusIcon className="size-[38%]" />
              </span>
              <span className={NAME}>{ADD_APP_TITLE}</span>
            </Link>
          </li>
        </ul>
      </div>
    </div>
  );
}
