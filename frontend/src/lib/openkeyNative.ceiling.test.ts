import { describe, expect, test } from "bun:test";
import type { Manifest } from "@tinycloud/sdk-core";
import APP_MANIFEST from "../../../manifest.json";
import HOME_MANIFEST from "../../../manifest.home.json";
import { nativePermissions } from "./openkeyNative";

/**
 * OpenKey's registered ceiling for the Exo native client, copied from openkey
 * docs/native-tinycloud-delegation.md ("Ceiling"). Change it only in the same
 * change that widens the registered client (TC-1990), never to make this test pass.
 */
const OPENKEY_EXO_CEILING = {
  kv: {
    paths: ["xyz.tinycloud.tinychat/threads/", "xyz.tinycloud.tinychat/connectors/"],
    actions: ["get", "put", "list", "del", "metadata"],
  },
  sql: {
    databases: ["xyz.tinycloud.tinychat/threads", "xyz.tinycloud.tinychat/canvas", "xyz.tinycloud.tinychat/connectors"],
    actions: ["read", "write", "schema"],
  },
} as const;

/** The reason OpenKey's PAR (apps/api/src/services/native-delegation/par.ts) would refuse one entry, or null. */
function parRefusal(permission: { service: string; space: string; path: string; actions: string[] }): string | null {
  if (permission.space !== "applications") return "space";
  if (permission.service === "tinycloud.capabilities") {
    return permission.path === "" && permission.actions.length === 1 && permission.actions[0] === "tinycloud.capabilities/read"
      ? null : "invalid capabilities permission";
  }
  if (permission.service === "tinycloud.kv") {
    const { paths, actions } = OPENKEY_EXO_CEILING.kv;
    const inPath = paths.some((allowed) => permission.path.startsWith(allowed));
    const inActions = permission.actions.every((action) =>
      action.startsWith("tinycloud.kv/") && (actions as readonly string[]).includes(action.slice("tinycloud.kv/".length)));
    return inPath && inActions ? null : "KV permission exceeds ceiling";
  }
  if (permission.service === "tinycloud.sql") {
    const { databases, actions } = OPENKEY_EXO_CEILING.sql;
    const inActions = permission.actions.every((action) =>
      action.startsWith("tinycloud.sql/") && (actions as readonly string[]).includes(action.slice("tinycloud.sql/".length)));
    return (databases as readonly string[]).includes(permission.path) && inActions ? null : "SQL permission exceeds ceiling";
  }
  return "unsupported service";
}

const app = "xyz.tinycloud.tinychat";
function manifest(permissions: unknown[]): Manifest {
  return { manifest_version: 1, app_id: app, name: "Home", permissions } as Manifest;
}

describe("native sign-in stays inside OpenKey's Exo native ceiling (TC-1989, TC-2720)", () => {
  for (const [name, served] of [["manifest.json", APP_MANIFEST], ["manifest.home.json", HOME_MANIFEST]] as const) {
    test(`every entry the native request sends for ${name} is one OpenKey's PAR accepts`, () => {
      const permissions = nativePermissions(served as unknown as Manifest);
      expect(permissions.map((permission) => ({ path: permission.path, service: permission.service, refusal: parRefusal(permission) }))
        .filter((entry) => entry.refusal !== null)).toEqual([]);
      expect(permissions[0]?.service).toBe("tinycloud.capabilities");
    });
  }

  test("the Exo manifest's chat, canvas and connector data still go on the native request", () => {
    const paths = nativePermissions(APP_MANIFEST as unknown as Manifest).map((permission) => `${permission.service}:${permission.path}`);
    expect(paths).toEqual([
      "tinycloud.capabilities:",
      `tinycloud.kv:${app}/threads/`,
      `tinycloud.sql:${app}/threads`,
      `tinycloud.sql:${app}/canvas`,
      `tinycloud.sql:${app}/connectors`,
      `tinycloud.kv:${app}/connectors/`,
    ]);
  });

  test("Home's feed databases and hook subscriptions are never requested natively", () => {
    const permissions = nativePermissions(manifest([
      { service: "tinycloud.sql", path: "home_feed", actions: ["read", "write", "schema"] },
      { service: "tinycloud.sql", path: "feed/", actions: ["read", "write", "schema"] },
      { service: "tinycloud.hooks", space: "applications", path: `sql/${app}/feed/`, actions: ["subscribe"], skipPrefix: true },
      { service: "tinycloud.hooks", space: "applications", path: `sql/${app}/home_feed`, actions: ["subscribe"], skipPrefix: true },
      { service: "tinycloud.hooks", space: "applications", path: `sql/${app}/threads`, actions: ["subscribe"], skipPrefix: true },
    ]));
    expect(permissions.map((permission) => permission.service)).toEqual(["tinycloud.capabilities"]);
  });

  test("an in-ceiling path asking for an action outside the ceiling is left off, not sent", () => {
    const permissions = nativePermissions(manifest([
      { service: "tinycloud.sql", path: "threads", actions: ["read", "write", "schema", "drop"] },
      { service: "tinycloud.kv", path: "threads/", actions: ["get", "admin"] },
      { service: "tinycloud.sql", path: "canvas", actions: ["tinycloud.kv/get"] },
      { service: "tinycloud.sql", path: "connectors", actions: [] },
    ]));
    expect(permissions.map((permission) => permission.service)).toEqual(["tinycloud.capabilities"]);
  });

  test("other apps' folders, other spaces and prefixless manifests admit nothing", () => {
    expect(nativePermissions(manifest([
      { service: "tinycloud.kv", path: "other.app/threads/", actions: ["get"], skipPrefix: true },
      { service: "tinycloud.sql", space: "secrets", path: "threads", actions: ["read"] },
      { service: "tinycloud.kv", path: "", actions: ["get"], skipPrefix: true },
    ])).map((permission) => permission.service)).toEqual(["tinycloud.capabilities"]);
    expect(nativePermissions({ ...manifest([{ service: "tinycloud.kv", path: "threads/", actions: ["get"] }]), prefix: "" } as Manifest)
      .map((permission) => permission.service)).toEqual(["tinycloud.capabilities"]);
  });
});
