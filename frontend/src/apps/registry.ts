// TinyCloud's own apps that One opens (One Apps). A hard-coded constant: no remote config, exact https origins.
// Dev origins exist only in dev builds; `import.meta.env.DEV` is false in production, so the minifier drops them.
//
// `ceiling(owner)` is the most One will ever delegate to the app: the abilities of the app's own manifest, copied from
// its repo (secret-manager src/lib/tinycloud-manifest.ts, OpenCredentials apps/open-credentials/src/lib/tinycloud-manifest.ts,
// tinycloud-explorer src/data/realExplorerDataSource.ts createExplorerManifest, billing app/src/lib/manifest.ts).
// It is a function because two apps name owner-bound resources (an encryption network, a per-address path).

import type { PermissionEntry } from "@tinycloud/web-sdk";
import type { LucideIcon } from "lucide-react";
import { BadgeCheck, CircleUserRound, Compass, KeyRound, Mic } from "lucide-react";

export type FramedAppId =
  | "xyz.tinycloud.secrets"
  | "xyz.tinycloud.opencredentials"
  | "xyz.tinycloud.explorer"
  | "xyz.tinycloud.account";

export type OneAppId = FramedAppId | "capture";

/** The signed-in owner the owner-bound ceiling entries are built for. */
export interface OneAppOwner {
  address: string;
  chainId: number;
}

interface OneAppBase {
  /** User text. Framed apps: the app manifest's own `name`/`description`, verbatim, until Monica supplies One's words. */
  name: string;
  /** Undefined until Monica supplies it (Capture has no description string yet). */
  description: string | undefined;
  icon: LucideIcon;
}

/** One's own screen, shown in the launcher but not framed. */
export interface NativeOneApp extends OneAppBase {
  id: "capture";
  kind: "native";
  /** One's route, e.g. `/chat/capture`. */
  route: string;
}

/** An app One opens in a frame at `/chat/apps/<id>`. */
export interface FramedOneApp extends OneAppBase {
  id: FramedAppId;
  kind: "framed";
  /**
   * The exact origin One frames and accepts messages from (`https://host`, no path, no trailing slash), chosen at
   * build time by build kind: production builds contain only the production origin.
   */
  origin: string;
  /** Path on the origin the frame opens (One adds `?embed=one`). */
  path: string;
  ceiling(owner: OneAppOwner): readonly PermissionEntry[];
}

export type OneApp = NativeOneApp | FramedOneApp;

// `__ONE_APPS_BUILD_KIND__` is replaced at build time (vite.config.ts; bunfig.toml for tests). Each origin below is a
// ternary on it written in place, so a production build folds every preview/dev origin away. Fail-closed: anything
// but an explicit "preview" or "dev" signal is production.
export const ONE_APPS_BUILD_KIND: "production" | "preview" | "dev" =
  __ONE_APPS_BUILD_KIND__ === "dev" ? "dev" : __ONE_APPS_BUILD_KIND__ === "preview" ? "preview" : "production";

/** One's own origins on which apps are framed (and that the apps accept as parent). Elsewhere a tile opens a new tab. */
export const ONE_HOST_ORIGINS: readonly string[] = __ONE_APPS_BUILD_KIND__ === "dev"
  ? ["https://tinycloud.one", "https://localhost:5186"]
  : __ONE_APPS_BUILD_KIND__ === "preview"
    ? ["https://tinycloud.one", "https://feat-one-apps.tinychat.pages.dev"]
    : ["https://tinycloud.one"];

/** Whether One frames apps on this page's origin; false → open the app in a new tab with no delegation. */
export function framesAppsHere(origin: string): boolean {
  return ONE_HOST_ORIGINS.includes(origin);
}

function ownerDid(owner: OneAppOwner): string {
  return `did:pkh:eip155:${owner.chainId}:${owner.address}`;
}

const kv = (space: string, path: string, actions: string[]): PermissionEntry =>
  ({ service: "tinycloud.kv", space, path, actions, skipPrefix: true });
const sql = (space: string, path: string, actions: string[]): PermissionEntry =>
  ({ service: "tinycloud.sql", space, path, actions, skipPrefix: true });

export const ONE_APPS: readonly OneApp[] = Object.freeze([
  {
    id: "capture",
    kind: "native",
    name: "Recording",
    description: undefined,
    icon: Mic,
    route: "/chat/capture",
  },
  {
    id: "xyz.tinycloud.secrets",
    kind: "framed",
    name: "TinyCloud Secrets",
    description: "Manage encrypted provider API keys, scoped secrets, and environment variables.",
    icon: KeyRound,
    origin: __ONE_APPS_BUILD_KIND__ === "dev" ? "https://localhost:5191"
      : __ONE_APPS_BUILD_KIND__ === "preview" ? "https://feat-one-apps-embed.tinycloud-secrets.pages.dev"
        : "https://secrets.tinycloud.xyz",
    path: "/app",
    ceiling: (owner) => [
      kv("secrets", "vault/secrets/", ["get", "list", "metadata"]),
      {
        service: "tinycloud.encryption",
        path: `urn:tinycloud:encryption:${ownerDid(owner)}:default`,
        actions: ["decrypt"],
        skipPrefix: true,
      },
      kv("secrets", "variables", ["list", "metadata"]),
      kv("secrets", "variables/", ["get", "put", "del", "list", "metadata"]),
      sql("secrets", "default", ["read", "write", "schema"]),
      { service: "tinycloud.capabilities", space: "secrets", path: "", actions: ["read"], skipPrefix: true },
    ],
  },
  {
    id: "xyz.tinycloud.opencredentials",
    kind: "framed",
    name: "OpenCredentials",
    description: "Issue, store, inspect, and prove OpenCredentials verifiable credentials.",
    icon: BadgeCheck,
    origin: __ONE_APPS_BUILD_KIND__ === "dev" ? "https://localhost:5192"
      : __ONE_APPS_BUILD_KIND__ === "preview" ? "https://feat-one-apps-embed.open-credentials.pages.dev"
        : "https://credentials.org",
    path: "/",
    ceiling: (owner) => [
      sql("credentials", "default", ["read", "write", "schema"]),
      kv("credentials", "payloads/", ["get", "put", "del", "list", "metadata"]),
      kv("credentials", "app-state/", ["get", "put", "del", "list", "metadata"]),
      { service: "tinycloud.capabilities", space: "credentials", path: "", actions: ["read"], skipPrefix: true },
      kv("credentials", `v1/held/${owner.address.toLowerCase()}/`, ["get", "list", "put", "del"]),
    ],
  },
  {
    id: "xyz.tinycloud.explorer",
    kind: "framed",
    name: "TinyCloud Explorer",
    description: "Spatial browser for TinyCloud spaces, SQL tables, and KV data.",
    icon: Compass,
    origin: __ONE_APPS_BUILD_KIND__ === "dev" ? "https://localhost:5193"
      : __ONE_APPS_BUILD_KIND__ === "preview" ? "https://feat-one-apps-embed.tinycloud-explorer.pages.dev"
        : "https://explorer.tinycloud.xyz",
    path: "/",
    ceiling: () => [
      { service: "tinycloud.kv", space: "applications", path: "", actions: ["get", "list", "put", "del"] },
      { service: "tinycloud.sql", space: "applications", path: "default", actions: ["read", "schema"] },
      { service: "tinycloud.kv", space: "public", path: "", actions: ["get", "list", "metadata"] },
      sql("secrets", "default", ["read"]),
      kv("secrets", "", ["list"]),
      kv("secrets", "vault/secrets", ["get", "list", "metadata"]),
      kv("secrets", "variables", ["get", "list", "metadata"]),
    ],
  },
  {
    id: "xyz.tinycloud.account",
    kind: "framed",
    name: "TinyCloud Account",
    description: "Manage TinyCloud account data, billing, spaces, and installed application manifests.",
    icon: CircleUserRound,
    origin: __ONE_APPS_BUILD_KIND__ === "dev" ? "https://localhost:5194"
      : __ONE_APPS_BUILD_KIND__ === "preview" ? "https://feat-one-apps-embed.tinycloud-account.pages.dev"
        : "https://account.tinycloud.xyz",
    path: "/",
    ceiling: () => [
      kv("account", "applications/", ["get", "list", "put"]),
      kv("account", "spaces/", ["get", "list", "put"]),
      { service: "tinycloud.space", space: "account", path: "", actions: ["list"], skipPrefix: true },
      sql("account", "account", ["read"]),
      { service: "tinycloud.delegation", space: "account", path: "", actions: ["list", "status"], skipPrefix: true },
    ],
  },
] satisfies OneApp[]);

export function oneApp(id: string): OneApp | undefined {
  return ONE_APPS.find((app) => app.id === id);
}

export function framedApp(id: string): FramedOneApp | undefined {
  const app = oneApp(id);
  return app?.kind === "framed" ? app : undefined;
}

/** The page the app opens, outside One's frame (a new tab, no delegation). */
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
