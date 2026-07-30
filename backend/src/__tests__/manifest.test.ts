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
        actions: ["read", "write", "schema"],
        description: "Store chat threads and messages in your space's SQL database.",
      },
      {
        service: "tinycloud.sql",
        path: "connectors",
        actions: ["read", "write", "schema"],
        description:
          "Store meeting metadata synced from connected sources (e.g. Fireflies) in your space's SQL database.",
      },
      {
        service: "tinycloud.kv",
        path: "connectors/",
        actions: ["get", "put", "del", "list"],
        description: "Store transcript content synced from connected sources in your space.",
      },
    ]);
  });

  // DataVaultService has two storage layouts. The local-envelope one stores an
  // entry as TWO objects (`keys/<vaultKey>` + `vault/<vaultKey>`); the
  // network-encrypted one stores only `vault/<vaultKey>`. node-sdk's
  // createVaultService always passes an `encryption` config and
  // `usesNetworkEncryption` is just `encryption !== undefined`, so the secrets
  // vault is ALWAYS network-encrypted and `keys/` is never touched — a probe on
  // a fresh session read it back KV_NOT_FOUND. No `keys/` grant is declared,
  // deliberately: granting a path the code cannot reach is dead surface. Re-add
  // it only if the SDK ever exposes a local-envelope mode.
  it("declares no keys/ grant — the network-encrypted vault never writes that path", () => {
    const manifest = runtimeManifest();
    const paths = (manifest.permissions ?? []).map((permission) => permission.path);
    expect(paths.some((path) => path.startsWith("keys/"))).toBe(false);
  });

  // The `secrets` shorthand is a top-level sibling of `permissions`, not an
  // entry in it: the SDK expands it into a `tinycloud.vault` grant on the
  // owner's `secrets` space. Declaring it is what lets `secrets.put` skip
  // runtime escalation. Only fireflies is declared because only fireflies
  // ships; the other registry entries reuse the secret name API_KEY, so
  // adding them means keying this map differently and overriding `name`.
  it("declares the fireflies secret so scoped puts need no escalation", () => {
    const manifest = runtimeManifest();

    expect(manifest.secrets).toEqual({
      API_KEY: {
        scope: "fireflies",
        actions: ["read", "write"],
        description: "Store your Fireflies API key, encrypted, in your secrets space.",
      },
    });
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
