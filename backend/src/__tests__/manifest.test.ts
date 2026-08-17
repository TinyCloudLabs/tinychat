import { describe, expect, it } from "bun:test";
import type { ServerInfoPermission } from "@tinyboilerplate/core";
import {
  APP_ID,
  THREADS_KV_PREFIX,
  backendDelegationPolicyHash,
  backendManifestConfig,
  backendDelegationResolvedPermissions,
  resolvePermissions,
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
  // runtime escalation.
  //
  // The map is keyed by SECRET NAME, not by connector — the trap the old
  // "only fireflies ships" note pointed at. Two connectors that both called
  // their secret API_KEY would collide on one key and silently take one
  // scope, so Google Meet is declared under its own name: it stores an OAuth
  // REFRESH_TOKEN, not an API key, and the honest name is also the
  // non-colliding one. Any third connector has to do the same.
  //
  // `delete` is granted UP FRONT rather than left to the SDK's escalation
  // modal. Escalation calls grantRuntimePermissions, which needs a wallet
  // signer; a restored session has none, so the modal renders and then fails
  // on Approve — it is unusable, not merely inconvenient. Disconnect therefore
  // has to carry the grant from sign-in consent. Verified against the SDK that
  // this is sufficient: in network-encryption mode (the only mode the secrets
  // vault runs in) DataVaultService.delete touches `vault/<key>` alone.
  //
  // INGEST-CUTOVER(plan §11) — re-rationalized, not relaxed. This declaration is about the
  // BROWSER's copy of the Fireflies key, in the user's own secrets space, and that half survives
  // the backend-ingest reversal untouched: a non-cohort user still syncs with it, and a cohort
  // user's browser still uses it for the Option-C parity write (plan §8.1 W6). The credential the
  // backend holds for a cohort address is a DIFFERENT one — an out-of-band OAuth token in the
  // backend's own credential store, wrapped by `CONNECTOR_CREDENTIAL_MASTER` (plan §6.2). It is
  // deliberately NOT here: routing backend custody through the user's secrets space would need a
  // `tinycloud.secrets` grant this manifest must never declare, which is exactly the shape plan
  // §9 row 3 excludes. So this assertion is kept as a regression guard: a secrets scope appearing
  // for anything but the browser's own key means custody moved into the delegation.
  it("declares each connector secret with delete, so disconnect needs no escalation", () => {
    const manifest = runtimeManifest();

    expect(manifest.secrets).toEqual({
      API_KEY: {
        scope: "fireflies",
        actions: ["read", "write", "delete"],
        description: "Store your Fireflies API key, encrypted, in your secrets space.",
      },
      REFRESH_TOKEN: {
        scope: "google-meet",
        actions: ["read", "write", "delete"],
        description:
          "Store your Google sign-in for Google Meet, encrypted, in your secrets space.",
      },
    });
  });

  // The collision guard the comment above argues for, asserted rather than assumed: one entry
  // per connector scope, and no two entries sharing a secret name. A future connector added
  // under `API_KEY` would overwrite the fireflies row in this object literal and this pin would
  // not see it — the scope count would silently drop by one, which is what this checks.
  it("keys the secrets map so no two connector scopes share a secret name", () => {
    const secrets = runtimeManifest().secrets ?? {};
    const names = Object.keys(secrets);
    const scopes = Object.values(secrets).map((entry) => entry.scope);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(scopes.sort()).toEqual(["fireflies", "google-meet"]);
  });

  // INGEST-CUTOVER(plan §11) — the `[threads/]` pin is the assertion findings §4 expected to
  // fall, and under this plan's design it does NOT: backend ingestion takes custody out of band
  // and writes meetings into the BACKEND's own encrypted store, so it mints no connector
  // delegation into anyone's space (plan §9 row 3, §8.1 W9). The pin is therefore kept and
  // promoted to an explicit regression guard: it is now the line between the reversal the
  // operator signed (a server-held credential + a server-side copy) and the strictly larger one
  // they did not (standing write access inside the user's space, the Listen shape). A second
  // permission appearing here is that larger reversal, whichever mode requested it.
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

  // The resolved policy is memoized for the process lifetime (§9.3) but is stored by
  // callers and serialized onto the wire, so each call must hand back its own array.
  it("hands every caller its own copy of the memoized resolved policy", () => {
    const first = backendDelegationResolvedPermissions("did:key:z6MkBackend");
    const second = backendDelegationResolvedPermissions("did:key:z6MkBackend");

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]!.actions).not.toBe(first[0]!.actions);

    first[0]!.actions.push("tinycloud.kv/tamper");
    expect(backendDelegationResolvedPermissions("did:key:z6MkBackend")[0]!.actions).not.toContain(
      "tinycloud.kv/tamper",
    );
  });
});

// `resolveManifest` is neither order- nor length-preserving, so `resolvePermissions` must
// match resolved entries back to their inputs by resolved path, never by array index.
// With the single-entry policy that ships today the difference is unobservable; with any
// multi-entry policy an index zip silently moves `skipPrefix`/`description` onto the wrong
// entry, and a lost `skipPrefix: true` changes the resolved path form and therefore both
// the coverage check and the policy hash (§3.2).
describe("resolvePermissions entry attribution", () => {
  // The `tinycloud.vault` entry is the load-bearing one: the SDK rewrites it to a
  // `tinycloud.kv` grant at `vault/<path>`, which the requested-path filter never matches,
  // so it drops out of the MIDDLE of the resolved array and shifts every index after it.
  const POLICY_ENTRIES: readonly ServerInfoPermission[] = [
    {
      service: "tinycloud.kv",
      path: "threads/",
      actions: ["get", "put", "del", "list"],
      description: "threads kv",
    },
    {
      service: "tinycloud.vault",
      path: "fireflies/API_KEY",
      actions: ["read", "write"],
      skipPrefix: true,
      description: "fireflies secret",
    },
    {
      service: "tinycloud.sql",
      path: "connectors",
      actions: ["read", "write"],
      description: "connectors sql",
    },
    {
      service: "tinycloud.kv",
      space: "secrets",
      path: "vault/other/API_KEY",
      actions: ["get", "put"],
      skipPrefix: true,
      description: "secrets space kv",
    },
    {
      service: "tinycloud.kv",
      path: "connectors/",
      actions: ["get", "put", "del", "list"],
      description: "connectors kv",
    },
  ];

  // Every entry that survives the filter, keyed by the resolved `service` + `path` the
  // node will see. The vault entry is deliberately absent: it resolves to a path outside
  // the requested set.
  const EXPECTED: Record<string, { description: string; skipPrefix: boolean | undefined }> = {
    [`tinycloud.kv ${APP_ID}/threads/`]: { description: "threads kv", skipPrefix: undefined },
    [`tinycloud.sql ${APP_ID}/connectors`]: {
      description: "connectors sql",
      skipPrefix: undefined,
    },
    [`tinycloud.kv ${APP_ID}/connectors/`]: {
      description: "connectors kv",
      skipPrefix: undefined,
    },
    "tinycloud.kv vault/other/API_KEY": {
      description: "secrets space kv",
      skipPrefix: true,
    },
  };

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
        item,
        ...rest,
      ]),
    );
  }

  function attributionOf(resolved: readonly ServerInfoPermission[]) {
    return Object.fromEntries(
      resolved.map((permission) => [
        `${permission.service} ${permission.path}`,
        { description: permission.description, skipPrefix: permission.skipPrefix },
      ]),
    );
  }

  it("keeps description and skipPrefix on their own entries under every input order", () => {
    const manifest = runtimeManifest();
    const orders = permutations(POLICY_ENTRIES);
    expect(orders).toHaveLength(120);

    for (const order of orders) {
      const resolved = resolvePermissions(manifest, order);

      expect(resolved).toHaveLength(Object.keys(EXPECTED).length);
      expect(attributionOf(resolved)).toEqual(EXPECTED);
    }
  });

  it("resolves the same policy regardless of the order the entries are declared in", () => {
    const manifest = runtimeManifest();
    const canonical = (permissions: readonly ServerInfoPermission[]) =>
      resolvePermissions(manifest, permissions)
        .map((permission) => JSON.stringify(permission))
        .sort();

    const declared = canonical(POLICY_ENTRIES);
    for (const order of permutations(POLICY_ENTRIES)) {
      expect(canonical(order)).toEqual(declared);
    }
  });

  it("still attributes correctly when the policy has a single entry", () => {
    const resolved = resolvePermissions(runtimeManifest(), [
      {
        service: "tinycloud.kv",
        path: "threads/",
        actions: ["get", "put", "del", "list"],
        description: "threads kv",
      },
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.path).toBe(THREADS_KV_PREFIX);
    expect(resolved[0]!.description).toBe("threads kv");
    expect(resolved[0]!.skipPrefix).toBeUndefined();
  });
});
