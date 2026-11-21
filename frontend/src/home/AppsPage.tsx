// The Apps destination (TC-2040): a list of links that open Share's existing
// runner in a new tab. Not embedded, and Home grants these apps nothing.
import { useMemo } from "react";
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
import { ONE_APPS, appRoute, appTarget, type OneApp } from "@/apps/registry";
import { APP_CAPTIONS, CONNECTORS_NAME } from "@/apps/strings";
import { PAGE_COLUMN, PageHeader } from "@/shell/PageHeader";
import { NAV_APP_IDS } from "@/shell/navApps";
import { ONE_APPS_ENABLED, ONE_NAV_ENABLED, appPinId, useNavPins } from "@/shell/navPins";
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

/** One's new navigation: the grid's tiles, every TinyCloud app then Connectors (One's own page), each opening its screen in One. */
export function gridTiles(pendingMeetings: number, apps: readonly OneApp[] = ONE_APPS): GridTile[] {
  const tiles: GridTile[] = apps.map((app) => ({
    pin: app.kind === "native" ? "capture" : appPinId(app.id),
    name: app.name,
    caption: APP_CAPTIONS[app.glyph],
    glyph: app.glyph,
    path: appRoute(app),
  }));
  tiles.push({ pin: "connectors", name: CONNECTORS_NAME, caption: APP_CAPTIONS.connectors, glyph: "connectors", path: PATHS.connectors, pending: pendingMeetings });
  return tiles;
}

function OneAppsPage({ accountDid, pendingMeetings, oneNav }: { accountDid: string | null; pendingMeetings: number; oneNav: boolean }) {
  const { pins, pin, unpin } = useNavPins(accountDid, NAV_APP_IDS);
  const tiles = useMemo(() => launcherTiles(pendingMeetings, window.location.origin), [pendingMeetings]);
  if (oneNav) return <AppsGrid tiles={gridTiles(pendingMeetings)} pins={pins} canPin={accountDid !== null} />;
  return <AppsLauncher tiles={tiles} pins={pins} canPin={accountDid !== null} onPin={pin} onUnpin={unpin} />;
}

interface AppsPageProps {
  apps?: readonly ShareApp[];
  /** One Apps: the signed-in account, whose pins the launcher edits. */
  accountDid?: string | null;
  /** One Apps: meetings waiting in Connectors, for its tile while it is not pinned. */
  pendingMeetings?: number;
  /** The build's flags (shell/navPins.ts); tests pass them. */
  oneApps?: boolean;
  oneNav?: boolean;
}

export function AppsPage({ apps = SHARE_APPS, accountDid = null, pendingMeetings = 0, oneApps = ONE_APPS_ENABLED, oneNav = ONE_NAV_ENABLED }: AppsPageProps) {
  if (oneApps) return <OneAppsPage accountDid={accountDid} pendingMeetings={pendingMeetings} oneNav={oneNav} />;
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
