// The Apps destination (TC-2040): a list of links that open Share's existing
// runner in a new tab. Not embedded, and Home grants these apps nothing.
import { useContext, useMemo } from "react";
import { ExternalLinkIcon, PlugIcon } from "lucide-react";

import {
  APPS_CONNECTORS_DESCRIPTION,
  APPS_EMPTY,
  APPS_LIST_LABEL,
  APPS_OPEN_IN_SHARE,
  APPS_OPENS_NEW_TAB,
  APPS_PAGE_LEAD,
  APPS_PAGE_TITLE,
} from "@/lib/homeStrings";
import { ONE_APPS, appRoute, appTarget, appUrl, framedApp, framesAppHere, type OneApp } from "@/apps/registry";
import { PlatformContext } from "@/lib/platform";
import { useSizeClass } from "@/lib/sizeClass";
import { APP_CAPTIONS, CONNECTORS_NAME } from "@/apps/strings";
import { PAGE_COLUMN, PageHeader } from "@/shell/PageHeader";
import { NAV_APP_IDS } from "@/shell/navApps";
import { ONE_ADD_APP_ENABLED, ONE_APPS_ENABLED, ONE_NAV_ENABLED, appPinId, useNavPins, type PinId } from "@/shell/navPins";
import { navKindFor } from "@/shell/navItems";
import { PATHS } from "@/shell/routes";
import { AppsGrid, type GridTile } from "./AppsGrid";
import { AppsLauncher, type LauncherTile } from "./AppsLauncher";
import { SHARE_APPS, shareRunUrl, type ShareApp } from "./shareApps";

/** The launcher's tiles: every TinyCloud app, then Connectors (which has its own page, not a frame). */
export function launcherTiles(pendingMeetings: number, origin: string): LauncherTile[] {
  const tiles: LauncherTile[] = ONE_APPS.flatMap((app) =>
    app.kind === "link"
      ? []
      : [{ pin: app.kind === "native" ? "capture" : appPinId(app.id), name: app.name, description: app.description, icon: app.icon, target: appTarget(app, origin) }],
  );
  tiles.push({
    pin: "connectors",
    name: "Connectors",
    description: APPS_CONNECTORS_DESCRIPTION,
    icon: PlugIcon,
    target: { kind: "route", path: PATHS.connectors },
    pending: pendingMeetings,
  });
  return tiles;
}

/**
 * One's new navigation: the grid's tiles, every TinyCloud app then Connectors (One's own page), each opening its screen
 * in One. On the web (`origin`, the page's), an app One doesn't frame here opens its own page in a new tab straight from
 * the tile instead; the phone app (null) has no tabs, so every tile opens its screen.
 */
export function gridTiles(pendingMeetings: number, apps: readonly OneApp[] = ONE_APPS, origin: string | null = null): GridTile[] {
  const tiles: GridTile[] = apps.map((app) => {
    const frame = app.kind === "native" ? undefined : framedApp(app.id);
    const opensOut = origin !== null && app.kind !== "native" && !(frame && framesAppHere(frame, origin));
    return {
      pin: app.kind === "native" ? "capture" : appPinId(app.id),
      name: app.name,
      caption: APP_CAPTIONS[app.glyph],
      glyph: app.glyph,
      path: appRoute(app),
      newTab: opensOut ? appUrl(app) : undefined,
    };
  });
  tiles.push({ pin: "connectors", name: CONNECTORS_NAME, caption: APP_CAPTIONS.connectors, glyph: "connectors", path: PATHS.connectors, pending: pendingMeetings });
  return tiles;
}

/** The grid on a phone: pinned apps first (in grid order), so a pinned app is one tap away; the rest keep their order. */
export function pinnedFirst(tiles: readonly GridTile[], pins: readonly PinId[]): GridTile[] {
  return [...tiles.filter((tile) => pins.includes(tile.pin)), ...tiles.filter((tile) => !pins.includes(tile.pin))];
}

function OneAppsPage({ accountDid, pendingMeetings }: { accountDid: string | null; pendingMeetings: number }) {
  const { pins, pin, unpin } = useNavPins(accountDid, NAV_APP_IDS);
  const platform = useContext(PlatformContext);
  const phone = navKindFor(useSizeClass()) === "tabbar";
  const tiles = useMemo(() => launcherTiles(pendingMeetings, window.location.origin), [pendingMeetings]);
  if (ONE_NAV_ENABLED) {
    const grid = gridTiles(pendingMeetings, ONE_APPS, platform === "web" ? window.location.origin : null);
    return (
      <AppsGrid
        tiles={phone ? pinnedFirst(grid, pins) : grid}
        pins={pins}
        canPin={accountDid !== null}
        onPin={pin}
        onUnpin={unpin}
        addApp={ONE_ADD_APP_ENABLED}
      />
    );
  }
  return <AppsLauncher tiles={tiles} pins={pins} canPin={accountDid !== null} onPin={pin} onUnpin={unpin} />;
}

interface AppsPageProps {
  apps?: readonly ShareApp[];
  /** One Apps: the signed-in account, whose pins the launcher edits. */
  accountDid?: string | null;
  /** One Apps: meetings waiting in Connectors, for its tile while it is not pinned. */
  pendingMeetings?: number;
}

export function AppsPage({ apps = SHARE_APPS, accountDid = null, pendingMeetings = 0 }: AppsPageProps) {
  if (ONE_APPS_ENABLED) return <OneAppsPage accountDid={accountDid} pendingMeetings={pendingMeetings} />;
  return (
    <div className="relative h-full overflow-y-auto" data-scroll-root>
      <PageHeader title={APPS_PAGE_TITLE} className={PAGE_COLUMN} />
      <div className={`${PAGE_COLUMN} flex flex-col gap-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]`}>
        <p className="text-body text-muted-foreground">{APPS_PAGE_LEAD}</p>
        {apps.length === 0 ? (
          <p className="text-body text-muted-foreground">{APPS_EMPTY}</p>
        ) : (
          <ul aria-label={APPS_LIST_LABEL} className="flex flex-col gap-2">
            {apps.map((app) => (
              <li key={app.appId}>
                <a
                  href={shareRunUrl(app.appId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-11 flex-col gap-1 rounded-lg border bg-card p-3 hover:bg-surface-2"
                >
                  <span className="flex items-center gap-2 text-body font-semibold text-foreground">
                    {app.name}
                    <ExternalLinkIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </span>
                  <span className="text-body text-muted-foreground">{app.description}</span>
                  <span className="text-label text-primary">
                    {APPS_OPEN_IN_SHARE} <span className="sr-only">({APPS_OPENS_NEW_TAB})</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
