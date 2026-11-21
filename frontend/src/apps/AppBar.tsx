// The open app's bar (One's new navigation, ONE_NAV_ENABLED): the app's icon and name as the screen's heading, Pin, and the app's own page in a
// new tab when it has one. Every app screen in One has it: framed apps, the apps One can't frame here, and One's own
// Recording and Connectors. No Back: the navigation's Apps item is the way back to the grid.
import { useContext, useEffect, useState } from "react";
import { ExternalLinkIcon, PinIcon } from "lucide-react";

import { openLinkInApp } from "@/feed/inAppLink";
import { appPinnedToast, appUnpinnedToast } from "@/lib/homeStrings";
import { PlatformContext } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { NAV_APP_IDS } from "@/shell/navApps";
import { useNavPins, type PinId } from "@/shell/navPins";
import { AppTileIcon, type GlyphId } from "./icons";
import { openSeparately, pinApp, unpinApp } from "./strings";

const TOAST_MS = 2400;
const ICON_BUTTON =
  "tap-transparent grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export interface AppBarProps {
  name: string;
  glyph: GlyphId;
  /** The signed-in account the pins are kept under; null hides Pin. */
  accountDid: string | null;
  pin: PinId;
  /** The app's own page; absent for One's own screens. */
  url?: string;
}

export function AppBar({ name, glyph, accountDid, pin, url }: AppBarProps) {
  const { pins, pin: addPin, unpin } = useNavPins(accountDid, NAV_APP_IDS);
  const pinned = pins.includes(pin);
  const platform = useContext(PlatformContext);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <header data-testid="app-bar" className="flex h-12 shrink-0 items-center gap-1 border-b border-border/70 pl-1 pr-1.5">
      <h1 tabIndex={-1} className="flex min-w-0 flex-1 items-center gap-2.5 pl-2 text-headline text-foreground outline-none">
        <AppTileIcon id={glyph} className="size-[26px]" />
        <span className="truncate">{name}</span>
      </h1>
      {accountDid !== null ? (
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={pinned ? unpinApp(name) : pinApp(name)}
          onClick={() => {
            if (pinned) unpin(pin);
            else addPin(pin);
            setMessage(pinned ? appUnpinnedToast(name) : appPinnedToast(name));
          }}
          className={cn(ICON_BUTTON, pinned && "text-foreground")}
        >
          <PinIcon aria-hidden className={cn("size-5", pinned && "fill-current")} />
        </button>
      ) : null}
      {url !== undefined ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={openSeparately(name, platform === "ios" || platform === "android")}
          onClick={(event) => openLinkInApp(url, event.nativeEvent, { sheet: false })}
          className={ICON_BUTTON}
        >
          <ExternalLinkIcon aria-hidden className="size-5" />
        </a>
      ) : null}
      <div role="status" className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tc-bottom-chrome,0px)+1rem)] z-40 flex justify-center px-4">
        {message === null ? null : (
          <span className="rounded-full bg-foreground px-4 py-2 text-label font-medium text-background shadow-lg">{message}</span>
        )}
      </div>
    </header>
  );
}
