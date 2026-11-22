// One's new navigation (ONE_NAV_ENABLED): the TinyCloud apps as a grid of app icons, three across, each opening its
// app's screen in One (or, on the web, an app One can't frame here straight in a new tab, marked ↗), then Add an app
// when it is on. A pinned app carries a small pin mark. Pinning: the open app's bar (apps/AppBar.tsx), a long press on
// a tile on touch screens, and a Pin button on a tile under the pointer. Presentational; AppsPage feeds it the
// registry and the account's pins.
import { useRef, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRightIcon, PinIcon, PlusIcon } from "lucide-react";

import { AppTileIcon, type GlyphId } from "@/apps/icons";
import { PinToast, usePinToast } from "@/apps/PinToast";
import { ADD_APP_TITLE, pinApp, unpinApp } from "@/apps/strings";
import { connectorsAriaLabel } from "@/chat/useBackgroundDrain";
import { APPS_LAUNCHER_TITLE, APPS_OPENS_NEW_TAB, APPS_PIN_HINT, appPinnedToast, appUnpinnedToast } from "@/lib/homeStrings";
import { cn } from "@/lib/utils";
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
  /** The app's own page, when the tile opens it in a new tab instead (the web, an app One can't frame here). */
  newTab?: string;
  /** Meetings waiting (Connectors): shown on the tile while the tile is not pinned. */
  pending?: number;
}

const TILE =
  "tc-launcher-tile tap-transparent relative flex w-full min-w-0 select-none flex-col items-center gap-2 rounded-lg px-1 py-2 text-center [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-0 sm:px-3 sm:pb-[18px] sm:pt-[22px]";
const ICON_SIZE = "size-[72px] sm:mb-3.5 sm:size-[88px]";
const NAME = "max-w-full truncate text-[0.8125rem] font-semibold leading-[1.125rem] text-foreground sm:text-headline";
/** How long a touch rests on a tile before it pins or unpins the app. */
export const LONG_PRESS_MS = 500;
/** A touch that moves further than this is a scroll, not a press. */
const SLOP_PX = 10;
/** How long after a long press's finger lifts its tap may still arrive (and is swallowed). */
const TAP_AFTER_PRESS_MS = 1000;

export interface AppsGridProps {
  tiles: readonly GridTile[];
  pins: readonly PinId[];
  /** Pinning needs a signed-in account to keep the pins under. */
  canPin: boolean;
  onPin: (pin: PinId) => void;
  onUnpin: (pin: PinId) => void;
  /** Ends the grid with Add an app (ONE_ADD_APP_ENABLED). */
  addApp: boolean;
}

export function AppsGrid({ tiles, pins, canPin, onPin, onUnpin, addApp }: AppsGridProps) {
  const [message, showMessage] = usePinToast();
  // The tap that ends a long press opens nothing, wherever it lands: pinning re-sorts the phone's grid (pinnedFirst), so
  // the finger is often over another tile by then. Infinity while that finger is still down (its release is heard on the
  // window, even off the grid), then a short deadline.
  const swallowTapUntil = useRef(0);
  const toggle = (tile: GridTile) => {
    const pinned = pins.includes(tile.pin);
    if (pinned) onUnpin(tile.pin);
    else onPin(tile.pin);
    showMessage(pinned ? appUnpinnedToast(tile.name) : appPinnedToast(tile.name));
  };
  const released = () => {
    window.removeEventListener("pointerup", released, true);
    window.removeEventListener("pointercancel", released, true);
    if (swallowTapUntil.current === Infinity) swallowTapUntil.current = performance.now() + TAP_AFTER_PRESS_MS;
  };
  const longPressed = (tile: GridTile) => {
    swallowTapUntil.current = Infinity;
    window.addEventListener("pointerup", released, true);
    window.addEventListener("pointercancel", released, true);
    toggle(tile);
  };
  return (
    <div className="relative h-full overflow-y-auto" data-scroll-root>
      <PageHeader title={APPS_LAUNCHER_TITLE} className={PAGE_COLUMN} />
      <div className={`${PAGE_COLUMN} flex flex-col gap-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]`}>
        {canPin && pins.length === 0 ? <p className="text-body text-muted-foreground">{APPS_PIN_HINT}</p> : null}
        <ul
          aria-label={APPS_LAUNCHER_TITLE}
          className="tc-launcher-grid grid grid-cols-3 gap-x-1 gap-y-[22px] sm:max-w-[40rem] sm:gap-2"
          onPointerDownCapture={() => { swallowTapUntil.current = 0; }}
          onClickCapture={(event: MouseEvent) => {
            if (performance.now() > swallowTapUntil.current) return;
            swallowTapUntil.current = 0;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {tiles.map((tile, index) => (
            <Tile
              key={tile.pin}
              tile={tile}
              index={index}
              pinned={pins.includes(tile.pin)}
              onToggle={canPin ? () => toggle(tile) : null}
              onLongPress={canPin ? () => longPressed(tile) : null}
            />
          ))}
          {/* An action, not an app: an outlined square, never pinned. */}
          {addApp ? (
            <li style={{ "--i": tiles.length } as CSSProperties} className="flex min-w-0">
              <Link to={PATHS.addApp} className={TILE}>
                <span aria-hidden="true" className={`${ICON_SIZE} grid place-items-center rounded-[27%] border-2 border-dashed border-muted-foreground/45 text-muted-foreground`}>
                  <PlusIcon className="size-[38%]" />
                </span>
                <span className={NAME}>{ADD_APP_TITLE}</span>
              </Link>
            </li>
          ) : null}
        </ul>
      </div>
      <PinToast message={message} />
    </div>
  );
}

/** A touch resting on a tile pins or unpins it (the grid swallows the tap that ends it). Mouse and pen never do. */
function useLongPress(onLongPress: (() => void) | null) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef({ x: 0, y: 0 });
  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  if (onLongPress === null) return {};
  return {
    onPointerDown: (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      start.current = { x: event.clientX, y: event.clientY };
      cancel();
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: PointerEvent) => {
      if (timer.current !== undefined && Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    // The long press is ours: no link menu or preview.
    onContextMenu: (event: MouseEvent) => event.preventDefault(),
  };
}

function Tile({
  tile,
  index,
  pinned,
  onToggle,
  onLongPress,
}: {
  tile: GridTile;
  index: number;
  pinned: boolean;
  onToggle: (() => void) | null;
  onLongPress: (() => void) | null;
}) {
  const press = useLongPress(onLongPress);
  const body = (
    <>
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
      <span className={cn(NAME, tile.newTab !== undefined && "flex items-center gap-0.5")}>
        <span className="truncate">{tile.name}</span>
        {tile.newTab !== undefined ? <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      </span>
      <span className="hidden max-w-full text-meta text-muted-foreground sm:mt-0.5 sm:block">{tile.caption}</span>
      {tile.newTab !== undefined ? <span className="sr-only">({APPS_OPENS_NEW_TAB})</span> : null}
    </>
  );
  const shared = {
    "data-pinned": pinned ? "" : undefined,
    className: TILE,
    ...press,
  };
  return (
    <li style={{ "--i": index } as CSSProperties} className="group relative flex min-w-0">
      {tile.newTab !== undefined ? (
        <a href={tile.newTab} target="_blank" rel="noopener noreferrer" {...shared}>
          {body}
        </a>
      ) : (
        <Link to={tile.path} aria-label={tile.pending && !pinned ? connectorsAriaLabel(tile.pending) : undefined} {...shared}>
          {body}
        </Link>
      )}
      {onToggle !== null ? (
        // Under a pointer: Pin on the tile's corner while it is hovered or focused.
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={pinned ? unpinApp(tile.name) : pinApp(tile.name)}
          onClick={onToggle}
          className="tap-transparent absolute right-1 top-1 hidden size-8 place-items-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity duration-150 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 fine:grid"
        >
          <PinIcon aria-hidden className={cn("size-4", pinned && "fill-current text-foreground")} />
        </button>
      ) : null}
    </li>
  );
}
