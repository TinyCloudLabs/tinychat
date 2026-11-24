import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { composeManifestRequest } from "@tinycloud/sdk-core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { homeFeatureCoverageEntries, sessionCoversHomeFeature, webSignInManifest } from "../homeFeatures";
import { LEGACY_KEYS_APPROVAL_DESCRIPTION } from "../homeStrings";
import { WEB_APP_MANIFEST } from "../webSignInPrefetch";
import { connectorKeyDecryptGrants, encryptionNetworkId, LEGACY_NETWORK_APPROVAL_MAX_MS, legacyNetworkDecryptRequest, withConnectorKeyGrants } from "./encryptionGrant";
import { resolveLegacyConnectorKeys } from "./legacyKeyReseal";

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv[BUILD_FLAG];
const NETWORK = encryptionNetworkId(ADDRESS);

type Flag = "unset" | "set";
function setFlag(flag: Flag) {
  if (flag === "set") buildEnv[BUILD_FLAG] = "true"; else delete buildEnv[BUILD_FLAG];
}
beforeEach(() => setFlag("unset"));
afterEach(() => {
  if (realFlag === undefined) delete buildEnv[BUILD_FLAG]; else buildEnv[BUILD_FLAG] = realFlag;
});

const flags: Flag[] = ["unset", "set"];
const EXACT_PATHS = connectorKeyDecryptGrants(ADDRESS).map((grant) => grant.path);

describe("the Connectors sign-in never asks for decrypt on the whole encryption network", () => {
  test.each(flags)("flag %s: no manifest entry and no composed resource has the bare network as its path", (flag) => {
    setFlag(flag);
    const manifest = webSignInManifest(WEB_APP_MANIFEST, ["connectors"], ADDRESS);
    expect((manifest.permissions ?? []).filter((entry) => entry.path === NETWORK)).toEqual([]);
    const resources = composeManifestRequest([manifest], { includeAccountRegistryPermissions: false }).resources;
    expect(resources.filter((entry) => entry.path === NETWORK)).toEqual([]);
    expect(resources.filter((entry) => entry.service === "tinycloud.encryption").map((entry) => entry.path).sort()).toEqual([...EXACT_PATHS].sort());
  });

  test.each(flags)("flag %s: the coverage set has no bare-network entry and holds the three exact keys", (flag) => {
    setFlag(flag);
    const coverage = homeFeatureCoverageEntries("connectors", ADDRESS);
    expect(coverage.filter((entry) => entry.path === NETWORK)).toEqual([]);
    for (const path of EXACT_PATHS) expect(coverage.some((entry) => entry.path === path)).toBe(true);
  });

  test.each(flags)("flag %s: a manifest that already lists the exact keys is returned as it is", (flag) => {
    setFlag(flag);
    const once = withConnectorKeyGrants(WEB_APP_MANIFEST, ADDRESS);
    expect(withConnectorKeyGrants(once, ADDRESS)).toBe(once);
  });
});

describe("the exact-key grants (restated from the removed whole-network helper's tests)", () => {
  test("the static manifest alone resolves to NO encryption grant", () => {
    // Pins why the helper has to exist: if this fails, the manifest started carrying the capability.
    const resources = composeManifestRequest([WEB_APP_MANIFEST], { includeAccountRegistryPermissions: false }).resources;
    expect(resources.filter((entry) => entry.service === "tinycloud.encryption")).toHaveLength(0);
  });

  test("a different signer gets different grants, not shared ones", () => {
    const other = "0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
    const mine = connectorKeyDecryptGrants(ADDRESS).map((grant) => grant.path);
    const theirs = connectorKeyDecryptGrants(other).map((grant) => grant.path);
    expect(mine).toHaveLength(3);
    expect(theirs).toHaveLength(3);
    for (const path of theirs) expect(mine).not.toContain(path);
    for (const path of theirs) expect(path.toLowerCase()).toContain(other.toLowerCase());
  });
});

describe("a session that holds only the exact keys", () => {
  /** A session whose approval is exactly the resources of the Connectors sign-in. */
  function sessionHolding() {
    const held = composeManifestRequest([webSignInManifest(WEB_APP_MANIFEST, ["connectors"], ADDRESS)], { includeAccountRegistryPermissions: false }).resources;
    return {
      hasPermissions: (wanted: { service: string; path: string; space?: string; actions: string[] }[]) =>
        wanted.every((want) => held.some((have) => have.service === want.service && have.path === want.path && have.space === want.space && want.actions.every((action) => have.actions.includes(action)))),
    };
  }

  test.each(flags)("flag %s: is covered for Connectors", (flag) => {
    setFlag(flag);
    const session = sessionHolding();
    expect(session.hasPermissions([{ service: "tinycloud.encryption", path: NETWORK, actions: ["decrypt"] }])).toBe(false);
    expect(sessionCoversHomeFeature(session as never, "connectors", ADDRESS)).toBe(true);
  });
});

describe("the older-keys approval", () => {
  test.each(flags)("flag %s: asks for exactly decrypt on the whole network, for at most an hour", async (flag) => {
    setFlag(flag);
    expect(legacyNetworkDecryptRequest(ADDRESS)).toEqual([
      { service: "tinycloud.encryption", path: NETWORK, actions: ["decrypt"], skipPrefix: true, description: LEGACY_KEYS_APPROVAL_DESCRIPTION },
    ]);
    // With the switch unset nothing is probed, so only the set switch reaches the approval.
    if (flag === "unset") return;
    const asked: { permissions: unknown; expiryMs: number }[] = [];
    const tcw = {
      secrets: { vault: { resealToKey: async () => ({ status: "pending" }) } },
      kv: { put: async () => ({ ok: true }) },
      session: () => ({ address: ADDRESS, chainId: 1, sessionKey: "k", siwe: `Expiration Time: ${new Date(Date.now() + 90 * 86_400_000).toISOString()}` }),
      setRuntimePermissionSigner: () => {},
      requestPermissions: async (permissions: unknown, options: { expiryMs: number }) => { asked.push({ permissions, expiryMs: options.expiryMs }); return { approved: false }; },
      hasPermissions: () => false,
    } as unknown as TinyCloudWeb;
    const outcome = await resolveLegacyConnectorKeys(tcw, ADDRESS, async () => ({ address: ADDRESS, openkey: { signMessage: async () => ({ signature: "0x" }) } }) as never);
    expect(outcome).toBe("declined");
    expect(asked).toHaveLength(1);
    expect(asked[0].permissions).toEqual(legacyNetworkDecryptRequest(ADDRESS));
    expect(asked[0].expiryMs).toBeLessThanOrEqual(LEGACY_NETWORK_APPROVAL_MAX_MS);
  });
});

describe("the on-demand request for earlier records sealed to the whole network", () => {
  test("stays buildable from the exported helpers, for any chain, as one decrypt on that network", () => {
    // A separate action (the move of earlier bot history) builds the same request from `encryptionNetworkId`; the sign-in does not.
    for (const chainId of [1, 10]) {
      const [entry, ...rest] = legacyNetworkDecryptRequest(ADDRESS, chainId);
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({ service: "tinycloud.encryption", path: encryptionNetworkId(ADDRESS, chainId), actions: ["decrypt"], skipPrefix: true });
    }
    expect(encryptionNetworkId(ADDRESS, 1)).toBe(NETWORK);
  });
});
