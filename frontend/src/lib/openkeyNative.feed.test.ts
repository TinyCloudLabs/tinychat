import { expect, test } from "bun:test";
import type { Manifest } from "@tinycloud/sdk-core";
import { nativePermissions } from "./openkeyNative";

const app = "xyz.tinycloud.tinychat";
function manifest(permissions: unknown[]): Manifest {
  return { manifest_version: 1, app_id: app, name: "Home", permissions } as Manifest;
}

test("the Home owner can initialize feed databases, save answers and subscribe without other app authority", () => {
  const grants = nativePermissions(manifest([
    { service: "tinycloud.sql", path: "home_feed", actions: ["read", "write", "schema"] },
    { service: "tinycloud.sql", path: "feed/", actions: ["read", "write", "schema"] },
    { service: "tinycloud.hooks", space: "applications", path: `sql/${app}/feed/`, actions: ["subscribe"], skipPrefix: true },
    { service: "tinycloud.hooks", space: "applications", path: `sql/${app}/home_feed`, actions: ["subscribe"], skipPrefix: true },
    { service: "tinycloud.hooks", space: "applications", path: `sql/${app}/threads`, actions: ["subscribe"], skipPrefix: true },
  ]));
  const feed = grants.find((grant) => grant.service === "tinycloud.sql" && grant.path === `${app}/feed/`);
  expect(feed?.actions).toContain("tinycloud.sql/write");
  expect(feed?.actions).toContain("tinycloud.sql/schema");
  expect(grants.find((grant) => grant.path === `sql/${app}/feed/`)?.actions).toEqual(["tinycloud.hooks/subscribe"]);
  expect(grants.find((grant) => grant.path === `sql/${app}/home_feed`)?.actions).toEqual(["tinycloud.hooks/subscribe"]);
  expect(grants.find((grant) => grant.path === `sql/${app}/threads`)?.actions).toEqual(["tinycloud.hooks/subscribe"]);
});

test("the native request carries the manifest as written; OpenKey's ceiling, not the app, refuses widening (TC-2720)", () => {
  const widened = { service: "tinycloud.hooks", path: "sql/other.app/feed/", actions: ["register"], skipPrefix: true };
  const grants = nativePermissions(manifest([
    widened,
    { service: "tinycloud.hooks", space: "secrets", path: `sql/${app}/feed/`, actions: ["subscribe"], skipPrefix: true },
    { service: "tinycloud.space", path: "", actions: ["info"], skipPrefix: true },
  ]));
  expect(grants.slice(1)).toEqual([
    { service: "tinycloud.hooks", space: "applications", path: "sql/other.app/feed/", actions: ["tinycloud.hooks/register"] },
  ]);
});
