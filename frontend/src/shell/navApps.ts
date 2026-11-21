// The TinyCloud apps the navigation can pin: the registry's framed apps, each
// with where appTarget sends it on this page's origin. Recording is a native
// pin (navPins.ts), not an app id.
import { ONE_APPS, appTarget } from "@/apps/registry";
import type { NavApp } from "./navItems";

const ORIGIN = globalThis.location?.origin ?? "";

export const NAV_APPS: readonly NavApp[] = ONE_APPS.flatMap((app) =>
  app.kind === "framed" ? [{ id: app.id, name: app.name, icon: app.icon, target: appTarget(app, ORIGIN) }] : [],
);
export const NAV_APP_IDS: readonly string[] = NAV_APPS.map((app) => app.id);
