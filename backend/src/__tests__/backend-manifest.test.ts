import { describe, expect, it } from "bun:test";
import { isCapabilitySubset, resolveManifest } from "@tinycloud/node-sdk/core";
import {
  assertBackendManifestCoversKvRoots,
  createTinychatBackendIdentity,
  TINYCHAT_BACKEND_KV_PREFIX,
  TINYCHAT_BACKEND_MANIFEST,
  tinychatBackendSignInConfig,
} from "../startup.js";

const INPUT = { privateKey: "0x" + "11".repeat(32), host: "http://127.0.0.1:9" };
const KV_ACTIONS = ["get", "put", "del", "list"].map((action) => `tinycloud.kv/${action}`);

function withoutRoot(path: string) {
  return {
    ...TINYCHAT_BACKEND_MANIFEST,
    permissions: TINYCHAT_BACKEND_MANIFEST.permissions!.filter((entry) => entry.path !== path),
  };
}

describe("TinyChat backend sign-in manifest", () => {
  it("signs in with its own key roots instead of the whole backend space", () => {
    const { manifest } = tinychatBackendSignInConfig(INPUT);
    const granted = resolveManifest(manifest!).resources;

    // Everything is in the backend's own space; besides KV, the SDK adds only capabilities/read there.
    for (const resource of granted) expect(resource.space).toBe(TINYCHAT_BACKEND_KV_PREFIX);
    expect(granted.filter((resource) => resource.service !== "tinycloud.kv").map((resource) => resource.actions)).toEqual([
      ["tinycloud.capabilities/read"],
    ]);
    const kv = granted.filter((resource) => resource.service === "tinycloud.kv");
    expect(kv.map((resource) => resource.path).sort()).toEqual([
      "assemblyai/hosted/spool-identity",
      "bot-history/grants/",
      "bots/registry/",
      "calendar-autojoin/v1/",
      "connector-content-continuity/v1",
      "connector-content-index/",
      "connector-content-key-failure/",
      "connector-content-replay-tombstone/",
      "connector-content/",
      "credentials/",
      "delegations/",
      "transcriber/",
      "trustbot/read-grants/",
      "webhooks/",
      "xyz.tinycloud.tinychat/exo/v1/",
    ]);
    const wholeSpace = [{ service: "tinycloud.kv", space: TINYCHAT_BACKEND_KV_PREFIX, path: "", actions: KV_ACTIONS }];
    expect(isCapabilitySubset(wholeSpace, granted).subset).toBe(false);
  });

  it("names the missing root when the manifest leaves out one the backend uses", () => {
    expect(() => assertBackendManifestCoversKvRoots(withoutRoot("bots/registry/"))).toThrow(
      "does not cover key roots the backend uses: bots/registry/.",
    );
    expect(() => assertBackendManifestCoversKvRoots(withoutRoot("webhooks/"))).toThrow(
      /webhooks\/tokens\/.*webhooks\/pending.*webhooks\/ingest\/instance-lease/,
    );
  });

  it("refuses to start, before contacting the node, when a root is missing", async () => {
    const permissions = TINYCHAT_BACKEND_MANIFEST.permissions!;
    const saved = [...permissions];
    permissions.splice(permissions.findIndex((entry) => entry.path === "credentials/"), 1);
    try {
      await expect(createTinychatBackendIdentity(INPUT)).rejects.toThrow(
        "does not cover key roots the backend uses: credentials/.",
      );
    } finally {
      permissions.splice(0, permissions.length, ...saved);
    }
  });
});
