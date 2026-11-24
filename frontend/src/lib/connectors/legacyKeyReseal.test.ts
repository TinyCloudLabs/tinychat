import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Manifest, TinyCloudWeb } from "@tinycloud/web-sdk";

import { carriesWholeNetworkDecrypt, webSignInRenewal } from "../renewalReceipt";
import { homeFeatureCoverageEntries, webSignInManifest } from "../homeFeatures";
import { WEB_APP_MANIFEST } from "../webSignInPrefetch";
import { LEGACY_KEYS_APPROVAL_DESCRIPTION } from "../homeStrings";
import { CONNECTORS_KV_PREFIX } from "@tinyboilerplate/core";
import { connectorKeyDecryptGrants, encryptionNetworkId, LEGACY_NETWORK_APPROVAL_MAX_MS, legacyNetworkDecryptRequest, withConnectorKeyGrants } from "./encryptionGrant";
import { moveLegacyConnectorKeys, probeConnectorKeys, resolveLegacyConnectorKeys } from "./legacyKeyReseal";
import { connectorNamedKeyWritesEnabled } from "./namedKeyWrites";

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv[BUILD_FLAG];

type Flag = "off" | "build";
/** "off": nothing set. "build": the build variable, as the bundler injects it into import.meta.env. */
function setFlag(flag: Flag) {
  if (flag === "build") buildEnv[BUILD_FLAG] = "true"; else delete buildEnv[BUILD_FLAG];
}
beforeEach(() => setFlag("off"));
afterEach(() => {
  if (realFlag === undefined) delete buildEnv[BUILD_FLAG]; else buildEnv[BUILD_FLAG] = realFlag;
});

const ASK = { version: 1, leaseLifetimeSeconds: 90 * 86_400, purpose: "standing" };
async function renewalAskFor(manifest: Manifest) {
  const requests: Record<string, unknown>[] = [];
  const openkey = { authorizeTinyCloud: async (request: Record<string, unknown>) => { requests.push(request); return {}; } };
  const renewal = webSignInRenewal(openkey as never, manifest);
  await renewal.config.openkey.client.authorizeTinyCloud({ siwe: "draft" } as never, { mode: "iframe" } as never);
  return requests[0]?.renewal;
}

interface Hooks {
  /** What the move itself (not the dry run) answers for a key path. */
  move?: (keyPath: string) => unknown;
  get?: (name: string, options?: { namedKeyOnly?: boolean; scope?: string }) => unknown;
  probes?: { count: number };
}
function fakeTcw(states: Record<string, "pending" | "already" | "not_found" | "boom">, hooks: Hooks = {}) {
  const puts: string[] = [];
  const probes = hooks.probes ?? { count: 0 };
  const fake = {
    secrets: {
      vault: {
        resealToKey: async (_vaultKey: string, keyPath: string, options?: { dryRun?: boolean }) => {
          if (options?.dryRun) probes.count++;
          const state = states[keyPath];
          if (state === "boom") throw new Error("sdk");
          if (state === "not_found") return { status: "skipped", reason: "not_found" };
          if (options?.dryRun) return { status: state };
          return hooks.move?.(keyPath) ?? { status: "moved" };
        },
      },
      get: async (name: string, options?: { namedKeyOnly?: boolean; scope?: string }) => hooks.get?.(name, options) ?? { ok: true, data: "value" },
    },
    kv: { put: async (key: string) => { puts.push(key); return { ok: true }; } },
  };
  // The page's `tcw` is far larger than the few members the older-keys step uses.
  const tcw = fake as unknown as TinyCloudWeb;
  return { tcw, puts, probes };
}
const ALL = { "secrets/fireflies_api_key": "pending", "secrets/granola_api_key": "pending", "secrets/scoped/google-meet/refresh_token": "pending" } as const;

describe("the grant a sign-in asks for is the same whichever way the switch is set; the switch decides whether older keys are probed", () => {
  test.each<Flag>(["off", "build"])("%s: the manifest, the lease, the coverage and the probe", async (flag) => {
    setFlag(flag);
    const ownKeys = connectorNamedKeyWritesEnabled();
    expect(ownKeys).toBe(flag === "build");
    const manifest = webSignInManifest(WEB_APP_MANIFEST, ["connectors"], ADDRESS);
    // The exact keys only, leased, whichever way the switch is set.
    expect(carriesWholeNetworkDecrypt(manifest)).toBe(false);
    expect(await renewalAskFor(manifest)).toEqual(ASK);
    const coversWholeNetwork = homeFeatureCoverageEntries("connectors", ADDRESS).some((entry) => entry.path === encryptionNetworkId(ADDRESS));
    expect(coversWholeNetwork).toBe(false);
    const probes = { count: 0 };
    const { tcw } = fakeTcw(ALL, { probes });
    const states = await probeConnectorKeys(tcw);
    expect(Object.keys(states).length > 0).toBe(ownKeys);
    expect(probes.count > 0).toBe(ownKeys);
  });

  test("a development build's own setting turns the same switch on, and nothing turns it on in a production build", () => {
    expect(connectorNamedKeyWritesEnabled({ DEV: true }, { getItem: () => "true" })).toBe(true);
    expect(connectorNamedKeyWritesEnabled({ DEV: false }, { getItem: () => "true" })).toBe(false);
    expect(connectorNamedKeyWritesEnabled({}, { getItem: () => "true" })).toBe(false);
  });

  test("a grant that carries the whole-network row is never leased, whichever way the switch is set", async () => {
    const withRow = { ...WEB_APP_MANIFEST, permissions: [...(WEB_APP_MANIFEST.permissions ?? []), ...legacyNetworkDecryptRequest(ADDRESS)] } as Manifest;
    for (const flag of ["off", "build"] as const) {
      setFlag(flag);
      expect(await renewalAskFor(withRow)).toBeUndefined();
    }
  });

  test("the exact keys are the same three whichever way the switch is set", () => {
    setFlag("build");
    const exact = connectorKeyDecryptGrants(ADDRESS);
    const manifest = withConnectorKeyGrants(WEB_APP_MANIFEST, ADDRESS);
    for (const grant of exact) expect(manifest.permissions).toContainEqual(grant);
    expect(exact).toHaveLength(3);
  });
});

describe("older connector keys", () => {
  beforeEach(() => setFlag("build"));

  test("the probe tells each key apart from its stored header alone; a key that fails to answer is unknown", async () => {
    const { tcw } = fakeTcw({ "secrets/fireflies_api_key": "pending", "secrets/granola_api_key": "already", "secrets/scoped/google-meet/refresh_token": "not_found" });
    expect(await probeConnectorKeys(tcw)).toEqual({ "secrets/fireflies_api_key": "legacy", "secrets/granola_api_key": "current", "secrets/scoped/google-meet/refresh_token": "absent" });
    const { tcw: broken } = fakeTcw({ ...ALL, "secrets/granola_api_key": "boom" });
    expect((await probeConnectorKeys(broken))["secrets/granola_api_key"]).toBe("unknown");
  });

  test("no older keys: no approval is asked", async () => {
    const { tcw } = fakeTcw({ "secrets/fireflies_api_key": "already", "secrets/granola_api_key": "not_found", "secrets/scoped/google-meet/refresh_token": "already" });
    let asked = 0;
    const outcome = await resolveLegacyConnectorKeys(tcw, ADDRESS, async () => { asked++; throw new Error("no"); });
    expect(outcome).toBe("nothing");
    expect(asked).toBe(0);
  });

  test("the approval is one whole-network decrypt row that says one hour and lasts at most an hour", async () => {
    const [entry, ...rest] = legacyNetworkDecryptRequest(ADDRESS);
    expect(rest).toEqual([]);
    expect(entry.actions).toContain("decrypt");
    expect(entry.description).toBe(LEGACY_KEYS_APPROVAL_DESCRIPTION);
    expect(LEGACY_NETWORK_APPROVAL_MAX_MS).toBe(3_600_000);
    const { tcw } = fakeTcw(ALL);
    const asked: { permissions: unknown; expiryMs: number }[] = [];
    const sessioned = Object.assign(tcw, {
      session: () => ({ address: ADDRESS, chainId: 1, sessionKey: "k", siwe: `Expiration Time: ${new Date(Date.now() + 90 * 86_400_000).toISOString()}` }),
      setRuntimePermissionSigner: () => {},
      requestPermissions: async (permissions: unknown, options: { expiryMs: number }) => { asked.push({ permissions, expiryMs: options.expiryMs }); return { approved: false }; },
      hasPermissions: () => false,
    });
    const outcome = await resolveLegacyConnectorKeys(sessioned, ADDRESS, async () => ({ address: ADDRESS, openkey: { signMessage: async () => ({ signature: "0x" }) } }) as never);
    expect(outcome).toBe("declined");
    expect(asked).toHaveLength(1);
    expect(asked[0].expiryMs).toBeLessThanOrEqual(LEGACY_NETWORK_APPROVAL_MAX_MS);
    expect(asked[0].permissions).toEqual(legacyNetworkDecryptRequest(ADDRESS));
  });

  test("a key moves only when the read back through its own key matches; each is marked then, never otherwise", async () => {
    const reads: unknown[] = [];
    const { tcw, puts } = fakeTcw(ALL, {
      get: (name, options) => {
        reads.push({ name, ...options });
        return { ok: true, data: options?.namedKeyOnly && name === "GRANOLA_API_KEY" ? "s3cret-other" : "s3cret-plain" };
      },
    });
    const report = await moveLegacyConnectorKeys(tcw);
    expect(report.moved).toEqual(["secrets/fireflies_api_key", "secrets/scoped/google-meet/refresh_token"]);
    expect(report.failed).toEqual([{ keyPath: "secrets/granola_api_key", code: "readback_mismatch" }]);
    expect(puts).toEqual([
      `${CONNECTORS_KV_PREFIX}/legacy-key-moved/secrets/fireflies_api_key`,
      `${CONNECTORS_KV_PREFIX}/legacy-key-moved/secrets/scoped/google-meet/refresh_token`,
    ]);
    expect(JSON.stringify(report)).not.toContain("s3cret");
    expect(reads).toContainEqual({ name: "REFRESH_TOKEN", scope: "google-meet", namedKeyOnly: true });
  });

  test("a failed step is reported by code only, leaves the key unmarked and does not stop the others", async () => {
    const { tcw, puts } = fakeTcw(ALL, { move: (keyPath) => (keyPath.includes("granola") ? { status: "skipped", reason: "write_failed" } : undefined) });
    const report = await moveLegacyConnectorKeys(tcw);
    expect(report.failed).toEqual([{ keyPath: "secrets/granola_api_key", code: "reseal_write_failed" }]);
    expect(report.moved).toHaveLength(2);
    expect(puts.some((key) => key.includes("granola"))).toBe(false);
  });

  test("the marker is only a hint: a key already on its own key needs nothing whether or not a marker was written", async () => {
    const { tcw, puts } = fakeTcw({ ...ALL, "secrets/granola_api_key": "already" });
    const report = await moveLegacyConnectorKeys(tcw);
    expect(report.failed).toEqual([]);
    expect(report.moved).toHaveLength(2);
    expect(puts.some((key) => key.includes("granola"))).toBe(false);
  });
});
