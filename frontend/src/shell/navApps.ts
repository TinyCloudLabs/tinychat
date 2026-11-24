// The TinyCloud apps the navigation can pin: the registry's framed apps, each
// with where appTarget sends it on this page's origin. Recording is a native
// pin (navPins.ts), not an app id. One's new navigation (ONE_NAV_ENABLED) pins
// every web app, each at its screen in One, with its glyph.
import { GLYPH_ICONS } from "@/apps/icons";
import { ONE_APPS, appRoute, appTarget } from "@/apps/registry";
import type { NavApp } from "./navItems";
import { ONE_NAV_ENABLED } from "./navPins";

const ORIGIN = globalThis.location?.origin ?? "";

export const NAV_APPS: readonly NavApp[] = ONE_APPS.flatMap((app): NavApp[] => {
  if (app.id === "capture") return [];
  if (ONE_NAV_ENABLED) return [{ id: app.id, name: app.name, icon: GLYPH_ICONS[app.glyph], target: { kind: "route", path: appRoute(app) } }];
  return app.kind !== "link" ? [{ id: app.id, name: app.name, icon: app.icon, target: appTarget(app, ORIGIN) }] : [];
});
export const NAV_APP_IDS: readonly string[] = NAV_APPS.map((app) => app.id);
