import { describe, expect, test } from "bun:test";
import { requestNonce } from "@tinyboilerplate/client";
import { resolveManifest, validateManifest, type ResourceCapability } from "@tinycloud/sdk-core";
import { manifestCarriesBundle } from "@tinyboilerplate/core";
import appManifest from "../../../manifest.json";
import { createWebSignInPrefetch } from "./webSignInPrefetch";
import { applyManifestRevisionGate, needsManifestResign } from "./manifestRevision";

const app = "xyz.tinycloud.tinychat";
const address = "0x1111111111111111111111111111111111111111";
const buildManifest = validateManifest(appManifest);
const oldBackendManifest = {
  ...buildManifest,
  permissions: buildManifest.permissions?.filter((permission) =>
    permission.path !== "home_feed" && permission.path !== "feed/" && permission.service !== "tinycloud.hooks"),
};

function backendFixture(manifestStatus = 200) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/nonce") return Response.json({ nonce: "web-manifest-fixture-nonce" });
      if (path === "/api/manifest") return Response.json(oldBackendManifest, { status: manifestStatus });
      return new Response("not found", { status: 404 });
    },
  });
  const services = { requestNonce };
  const attempt = createWebSignInPrefetch(server.url.origin, services);
  return { attempt, close: () => { attempt.cancel(); server.stop(true); } };
}

function authorityKey(resource: ResourceCapability) {
  return JSON.stringify([resource.service, resource.space, resource.path, [...resource.actions].sort()]);
}

describe("web sign-in authority from the deployed frontend", () => {
  test("adds only the five Home resource grants when the backend manifest predates Home", async () => {
    const fixture = backendFixture();
    try {
      const manifest = await fixture.attempt.manifest();
      expect(await fixture.attempt.nonceForSigning(address)).toBe("web-manifest-fixture-nonce");
      const oldAuthority = new Set(resolveManifest(oldBackendManifest).resources.map(authorityKey));
      const granted = resolveManifest(manifest).resources;
      const added = granted.filter((resource) => !oldAuthority.has(authorityKey(resource)));
      expect(added.map(authorityKey).sort()).toEqual([
        { service: "tinycloud.sql", space: "applications", path: `${app}/home_feed`, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] },
        { service: "tinycloud.sql", space: "applications", path: `${app}/feed/`, actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] },
        { service: "tinycloud.hooks", space: "applications", path: `sql/${app}/home_feed`, actions: ["tinycloud.hooks/subscribe"] },
        { service: "tinycloud.hooks", space: "applications", path: `sql/${app}/feed/`, actions: ["tinycloud.hooks/subscribe"] },
        { service: "tinycloud.hooks", space: "applications", path: `sql/${app}/threads`, actions: ["tinycloud.hooks/subscribe"] },
      ].map(authorityKey).sort());
      const grantedAuthority = new Set(granted.map(authorityKey));
      expect([...oldAuthority].filter((resource) => !grantedAuthority.has(resource))).toEqual([]);
    } finally { fixture.close(); }
  });

  test("an unavailable backend manifest cannot remove Home from a new sign-in", async () => {
    const fixture = backendFixture(503);
    try {
      const manifest = await fixture.attempt.manifest();
      expect(manifestCarriesBundle(manifest)).toBe(true);
      expect(await fixture.attempt.nonceForSigning(address)).toBe("web-manifest-fixture-nonce");
    } finally { fixture.close(); }
  });

  test("an existing owner is handed off and cleared for explicit consent even while the backend serves old grants", async () => {
    const fixture = backendFixture();
    const key = `xyz.tinycloud.tinychat:manifest-revision:${address}`;
    const revisions = new Map([[key, "3"]]);
    const store = { getItem: (name: string) => revisions.get(name) ?? null, setItem: (name: string, value: string) => { revisions.set(name, value); } };
    const transitions: string[] = [];
    try {
      const manifest = await fixture.attempt.manifest();
      const result = await applyManifestRevisionGate({
        store,
        address,
        isOffline: () => false,
        servedManifestCarriesBundle: async () => manifestCarriesBundle(manifest),
        handoff: async () => { transitions.push("handoff"); return true; },
        clearSession: (owner) => { transitions.push(`clear:${owner}`); },
      });
      expect(result).toBe("cleared");
      expect(transitions).toEqual(["handoff", `clear:${address}`]);
      expect(needsManifestResign(store, address)).toBe(true);
      expect(await fixture.attempt.nonceForSigning(address)).toBe("web-manifest-fixture-nonce");
    } finally { fixture.close(); }
  });
});
