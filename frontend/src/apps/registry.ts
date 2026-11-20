// TinyCloud's own apps that One opens (One Apps). A hard-coded constant: no remote config, exact https origins.
//
// `ceiling(owner)` is the most One will ever delegate to the app: the abilities of the app's own manifest, copied from
// its repo (secret-manager src/lib/tinycloud-manifest.ts, OpenCredentials apps/open-credentials/src/lib/tinycloud-manifest.ts,
// tinycloud-explorer src/data/realExplorerDataSource.ts createExplorerManifest, billing app/src/lib/manifest.ts).
// It is a function because two apps name owner-bound resources (an encryption network, a per-address path). Each
// entry carries the `<scope>` phrase the ask card shows for it (strings.ts).

import { Capacitor } from "@capacitor/core";
import type { PermissionEntry } from "@tinycloud/web-sdk";
import type { LucideIcon } from "lucide-react";
import { BadgeCheck, CircleUserRound, Compass, KeyRound, MessagesSquare, Mic } from "lucide-react";
import { APP_DESCRIPTIONS, APP_NAMES, type ScopeId } from "./strings";

export type FramedAppId =
  | "xyz.tinycloud.secrets"
  | "xyz.tinycloud.opencredentials"
  | "xyz.tinycloud.explorer"
  | "xyz.tinycloud.account"
  | "xyz.tinycloud.courier";

export type OneAppId = FramedAppId | "capture";

/** The signed-in owner the owner-bound ceiling entries are built for. */
export interface OneAppOwner {
  address: string;
  chainId: number;
}

/** One ceiling ability and the plain-words phrase the ask card names it by. */
export interface CeilingEntry {
  scope: ScopeId;
  permission: PermissionEntry;
}

interface OneAppBase {
  name: string;
  description: string;
  icon: LucideIcon;
}

/** One's own screen, shown in the launcher but not framed. */
export interface NativeOneApp extends OneAppBase {
  id: "capture";
  kind: "native";
  /** One's route. */
  route: string;
}

/** A TinyCloud web app: framed at `/chat/apps/<id>` when `framed`, else opened in a new tab. */
export interface FramedOneApp extends OneAppBase {
  id: FramedAppId;
  kind: "framed";
  /**
   * Whether One frames this app (with a delegation). False → its tile always opens `appUrl` in a new tab with no
   * delegation. Secrets is false.
   */
  framed: boolean;
  /**
   * The exact origin One frames and accepts messages from (`https://host`, no path, no trailing slash), chosen at
   * build time by build kind: production builds contain only the production origin.
   */
  origin: string;
  /** Path on the origin the frame opens (One adds `?embed=one`). */
  path: string;
  /**
   * Whether the phone app frames this app too. The phone app's session holds only One's own `applications` data and
   * cannot step up, so only an app that works on that is framed there; the rest open in the in-app browser.
   */
  inNativeApp: boolean;
  ceiling(owner: OneAppOwner): readonly CeilingEntry[];
}

export type OneApp = NativeOneApp | FramedOneApp;

// `__ONE_APPS_BUILD_KIND__` is replaced at build time (vite.config.ts; bunfig.toml for tests). Bundlers that don't
// define it (a test's Bun.build) read it as undefined, which is production. Each origin below is a ternary on
// `ONE_APPS_BUILD_KIND` written in place, so a production build folds every preview/dev origin away (the production
// build test checks). Fail-closed: anything but an explicit "preview" or "dev" signal is production.
export const ONE_APPS_BUILD_KIND: "production" | "preview" | "dev" = typeof __ONE_APPS_BUILD_KIND__ === "undefined"
  ? "production"
  : __ONE_APPS_BUILD_KIND__ === "dev" ? "dev" : __ONE_APPS_BUILD_KIND__ === "preview" ? "preview" : "production";
const KIND = ONE_APPS_BUILD_KIND;

/** One's own origins on which apps are framed (and that the apps accept as parent). Elsewhere a tile opens a new tab. */
export const ONE_HOST_ORIGINS: readonly string[] = KIND === "dev"
  ? ["https://tinycloud.one", "https://localhost:5190"]
  : KIND === "preview"
    ? ["https://tinycloud.one", "https://feat-one-apps.tinychat.pages.dev"]
    : ["https://tinycloud.one"];

/** Whether One frames apps on this page's origin; false → open the app in a new tab with no delegation. */
export function framesAppsHere(origin: string): boolean {
  return ONE_HOST_ORIGINS.includes(origin);
}

/**
 * The phone app's own origins (Capacitor's defaults; mobile/capacitor.config.ts sets no scheme or hostname): iOS, then
 * Android. Exact strings: no other scheme, port or host.
 */
export const ONE_NATIVE_ORIGINS: readonly string[] = ["capacitor://localhost", "https://localhost"];

/** Whether One frames `app` on this page's origin: any framed app on One's web origins, `inNativeApp` ones in the phone app. */
export function framesAppHere(app: FramedOneApp, origin: string): boolean {
  if (!app.framed) return false;
  return framesAppsHere(origin) || (app.inNativeApp && ONE_NATIVE_ORIGINS.includes(origin));
}

function ownerDid(owner: OneAppOwner): string {
  return `did:pkh:eip155:${owner.chainId}:${owner.address}`;
}

const entry = (scope: ScopeId, permission: PermissionEntry): CeilingEntry => ({ scope, permission });
const kv = (scope: ScopeId, space: string, path: string, actions: string[]): CeilingEntry =>
  entry(scope, { service: "tinycloud.kv", space, path, actions, skipPrefix: true });
const sql = (scope: ScopeId, space: string, path: string, actions: string[]): CeilingEntry =>
  entry(scope, { service: "tinycloud.sql", space, path, actions, skipPrefix: true });
const capabilities = (space: string): CeilingEntry =>
  entry("capabilityList", { service: "tinycloud.capabilities", space, path: "", actions: ["read"], skipPrefix: true });

const text = (id: OneAppId) => ({ name: APP_NAMES[id], description: APP_DESCRIPTIONS[id] });

// Ceiling entries the phone app's step-up ceilings (below) reuse verbatim.
const EXPLORER_APPS_SQL = entry("appsData", { service: "tinycloud.sql", space: "applications", path: "default", actions: ["read", "schema"] });
const EXPLORER_PUBLIC = entry("publicSpace", { service: "tinycloud.kv", space: "public", path: "", actions: ["get", "list", "metadata"] });
const ACCOUNT_CEILING: readonly CeilingEntry[] = [
  kv("installedApps", "account", "applications/", ["get", "list"]),
  kv("spaces", "account", "spaces/", ["get", "list"]),
];
const COURIER_CEILING: readonly CeilingEntry[] = [kv("courier", "agents", "xyz.tinycloud.courier/", ["get", "list"])];

const ALL_APPS: readonly OneApp[] = [
  { id: "capture", kind: "native", ...text("capture"), icon: Mic, route: "/chat/capture" },
  {
    id: "xyz.tinycloud.secrets",
    kind: "framed",
    framed: false,
    inNativeApp: false,
    ...text("xyz.tinycloud.secrets"),
    icon: KeyRound,
    origin: KIND === "dev" ? "https://localhost:5191"
      : KIND === "preview" ? "https://feat-one-apps-embed.tinycloud-secrets.pages.dev"
        : "https://secrets.tinycloud.xyz",
    path: "/app",
    ceiling: (owner) => [
      kv("secrets", "secrets", "vault/secrets/", ["get", "list", "metadata"]),
      entry("secrets", {
        service: "tinycloud.encryption",
        path: `urn:tinycloud:encryption:${ownerDid(owner)}:default`,
        actions: ["decrypt"],
        skipPrefix: true,
      }),
      kv("variables", "secrets", "variables", ["list", "metadata"]),
      kv("variables", "secrets", "variables/", ["get", "put", "del", "list", "metadata"]),
      sql("secretsAppData", "secrets", "default", ["read", "write", "schema"]),
      capabilities("secrets"),
    ],
  },
  {
    id: "xyz.tinycloud.opencredentials",
    kind: "framed",
    framed: false, // opens in a new tab
    inNativeApp: false,
    ...text("xyz.tinycloud.opencredentials"),
    icon: BadgeCheck,
    origin: KIND === "dev" ? "https://localhost:5192"
      : KIND === "preview" ? "https://feat-one-apps-embed.open-credentials.pages.dev"
        : "https://credentials.org",
    path: "/",
    ceiling: (owner) => [
      sql("credentials", "credentials", "default", ["read", "write", "schema"]),
      kv("credentials", "credentials", "payloads/", ["get", "put", "del", "list", "metadata"]),
      kv("credentials", "credentials", "app-state/", ["get", "put", "del", "list", "metadata"]),
      capabilities("credentials"),
      kv("credentials", "credentials", `v1/held/${owner.address.toLowerCase()}/`, ["get", "list", "put", "del"]),
    ],
  },
  {
    id: "xyz.tinycloud.explorer",
    kind: "framed",
    framed: true,
    // In the phone app Explorer gets One's `applications` data; its other views ask, and the phone app cannot step up.
    inNativeApp: true,
    ...text("xyz.tinycloud.explorer"),
    icon: Compass,
    origin: KIND === "dev" ? "https://localhost:5193"
      : KIND === "preview" ? "https://feat-one-apps-embed.tinycloud-explorer.pages.dev"
        : "https://explorer.tinycloud.xyz",
    path: "/",
    ceiling: () => [
      entry("appsData", { service: "tinycloud.kv", space: "applications", path: "", actions: ["get", "list", "put", "del"] }),
      EXPLORER_APPS_SQL,
      EXPLORER_PUBLIC,
      sql("secretNames", "secrets", "default", ["read"]),
      kv("secretNames", "secrets", "", ["list"]),
      kv("secretNames", "secrets", "vault/secrets", ["get", "list", "metadata"]),
      kv("secretNames", "secrets", "variables", ["get", "list", "metadata"]),
    ],
  },
  {
    id: "xyz.tinycloud.account",
    kind: "framed",
    framed: true,
    inNativeApp: false, // `account` space: not in the phone app's session
    ...text("xyz.tinycloud.account"),
    icon: CircleUserRound,
    origin: KIND === "dev" ? "https://localhost:5194"
      : KIND === "preview" ? "https://feat-one-apps-embed.tinycloud-account.pages.dev"
        : "https://account.tinycloud.xyz",
    path: "/",
    ceiling: () => ACCOUNT_CEILING,
  },
  {
    // Courier's data view lives on the share site; only its `/courier` pages may be framed (share repo headers).
    // Read-only in the frame: approving, denying and saving orders open Courier in a new tab.
    id: "xyz.tinycloud.courier",
    kind: "framed",
    framed: true,
    inNativeApp: false, // `agents` space: not in the phone app's session
    ...text("xyz.tinycloud.courier"),
    icon: MessagesSquare,
    origin: KIND === "dev" ? "https://localhost:5195" : "https://share.tinycloud.xyz",
    path: "/courier",
    ceiling: () => COURIER_CEILING,
  },
];

/**
 * What the phone app may ask OpenKey for on an app's behalf, beyond One's sign-in (TC-3568 S1b, phase 1): read-only,
 * each entry copied from the app's ceiling. No secrets, vault or encryption entry: those need their own ruling.
 * OpenKey enforces exactly these per app on the Home client; `native-step-up-ceilings.json` is the copy its CI
 * compares against, kept equal to this by the registry test.
 */
export const NATIVE_STEP_UP_CEILINGS: Readonly<Partial<Record<FramedAppId, readonly CeilingEntry[]>>> = Object.freeze({
  "xyz.tinycloud.explorer": [EXPLORER_PUBLIC, EXPLORER_APPS_SQL],
  "xyz.tinycloud.account": ACCOUNT_CEILING,
  "xyz.tinycloud.courier": COURIER_CEILING,
});

/**
 * The apps a platform offers. iOS leaves Account out: its tile would open account.tinycloud.xyz, which has Billing.
 */
export function oneAppsFor(platform: string): readonly OneApp[] {
  return Object.freeze(ALL_APPS.filter((app) => !(platform === "ios" && app.id === "xyz.tinycloud.account")));
}

export const ONE_APPS: readonly OneApp[] = oneAppsFor(Capacitor.getPlatform());

export function oneApp(id: string): OneApp | undefined {
  return ONE_APPS.find((app) => app.id === id);
}

/** The app One frames for `id`, or undefined (unknown id, native app, or an app that opens in a new tab). */
export function framedApp(id: string): FramedOneApp | undefined {
  const app = oneApp(id);
  return app?.kind === "framed" && app.framed ? app : undefined;
}

export type AppTarget = { kind: "route"; path: string } | { kind: "newTab"; url: string };

/**
 * Where a tile goes on a page at `origin` (`window.location.origin`): One's route for native apps and for apps One
 * frames here; otherwise the app's own page in a new tab, with no delegation.
 */
export function appTarget(app: OneApp, origin: string): AppTarget {
  if (app.kind === "native") return { kind: "route", path: app.route };
  if (framesAppHere(app, origin)) return { kind: "route", path: appRoute(app) };
  return { kind: "newTab", url: appUrl(app) };
}

/** The page the app opens outside One's frame (a new tab, no delegation). */
export function appUrl(app: FramedOneApp): string {
  return new URL(app.path, app.origin).toString();
}

/** One's route for an app: its own screen for a native app, else the framed surface. */
export function appRoute(app: OneApp): string {
  return app.kind === "native" ? app.route : `/chat/apps/${encodeURIComponent(app.id)}`;
}

/** The frame's URL: the app's page in embedded mode. */
export function frameUrl(app: FramedOneApp): string {
  const url = new URL(app.path, app.origin);
  url.searchParams.set("embed", "one");
  return url.toString();
}
