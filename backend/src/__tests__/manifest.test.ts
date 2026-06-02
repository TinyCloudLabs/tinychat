import { describe, expect, it } from "bun:test";
import {
  APP_ID,
  THREADS_KV_PREFIX,
  backendDelegationPolicyHash,
  backendManifestConfig,
  backendDelegationResolvedPermissions,
  runtimeManifest,
} from "../manifest.js";

describe("TinyChat manifest and backend policy", () => {
  it("serves a v1 app/data manifest with explicit permissions only", () => {
    const manifest = runtimeManifest();

    expect(manifest.manifest_version).toBe(1);
    expect(manifest.app_id).toBe(APP_ID);
    expect(manifest.name).toBe("TinyCloud Chat");
    expect(manifest.defaults).toBe(false);
    expect("backend" in manifest).toBe(false);
    expect("delegations" in manifest).toBe(false);
    expect(manifest.permissions).toEqual([
      {
        service: "tinycloud.kv",
        path: "threads/",
        actions: ["get", "put", "del", "list"],
        description: "Read and write chat threads and messages.",
      },
      {
        service: "tinycloud.sql",
        path: "threads",
        actions: ["read", "write"],
        description: "Store chat threads and messages in your space's SQL database.",
      },
    ]);
  });

  it("derives and hashes backend policy from resolved runtime manifest permissions", () => {
    const backendDid = "did:key:z6MkBackend";
    const config = backendManifestConfig(backendDid);
    const resolved = backendDelegationResolvedPermissions(backendDid);

    expect(config.name).toBe("TinyChat Backend");
    expect(config.expiry).toBe("7d");
    expect(config.permissions).toHaveLength(1);
    expect(resolved.map((permission) => permission.path)).toEqual([THREADS_KV_PREFIX]);
    expect(THREADS_KV_PREFIX).toBe(`${APP_ID}/threads/`);
    expect(backendDelegationPolicyHash(backendDid)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds the backend policy hash to the backend DID", () => {
    expect(backendDelegationPolicyHash("did:key:z6MkBackendA")).not.toBe(
      backendDelegationPolicyHash("did:key:z6MkBackendB"),
    );
  });
});
