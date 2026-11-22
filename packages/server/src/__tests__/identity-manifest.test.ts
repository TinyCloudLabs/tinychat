import { describe, expect, mock, test } from "bun:test";
import { isCapabilitySubset, resolveManifest } from "@tinycloud/node-sdk/core";

// The backend keeps all of its own state in this space and reaches it through node.kv.
const PREFIX = "ops.tinychat.backend";
const KV_ACTIONS = ["get", "put", "del", "list"].map((action) => `tinycloud.kv/${action}`);

type NodeConfig = { prefix?: string; manifest?: unknown };

async function signInConfig(): Promise<NodeConfig> {
  let captured: NodeConfig | undefined;
  // The suite preloads an empty TinyCloudNode; swap in one that records its config.
  mock.module("@tinycloud/node-sdk", () => ({
    TinyCloudNode: class {
      did = "did:pkh:eip155:1:0x0";
      constructor(config: NodeConfig) {
        captured = config;
      }
      async signIn() {}
    },
  }));
  // Dynamic on purpose: the mock above must be in place before identity.ts binds TinyCloudNode,
  // and the query string gives this file its own copy of the module.
  const { createBackendIdentity } = await import("../identity.js?backend-manifest");
  await createBackendIdentity({ privateKey: "0x" + "11".repeat(32), host: "https://offline.invalid", prefix: PREFIX });
  if (captured === undefined) throw new Error("TinyCloudNode was not constructed");
  return captured;
}

describe("backend sign-in manifest", () => {
  test("createBackendIdentity signs in with a manifest, not the SDK defaults", async () => {
    const config = await signInConfig();
    expect(config.prefix).toBe(PREFIX);
    expect(config.manifest).toBeDefined();
  });

  test("the manifest grants KV get, put, del and list on the backend's own space", async () => {
    const { manifest } = await signInConfig();
    const granted = resolveManifest(manifest as Parameters<typeof resolveManifest>[0]).resources;
    const needed = [{ service: "tinycloud.kv", space: PREFIX, path: "", actions: KV_ACTIONS }];
    expect(isCapabilitySubset(needed, granted)).toEqual({ subset: true, missing: [] });
  });

  test("the manifest asks for nothing outside the backend's own space", async () => {
    const { manifest } = await signInConfig();
    const granted = resolveManifest(manifest as Parameters<typeof resolveManifest>[0]).resources;
    expect(granted.length).toBeGreaterThan(0);
    for (const resource of granted) expect(resource.space).toBe(PREFIX);
  });
});
