import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { Manifest } from "@tinycloud/web-sdk";

import { webSignInManifest } from "../homeFeatures";
import {
  CONNECTOR_SECRET_KEYS,
  connectorKeyDecryptGrants,
  encryptionNetworkId,
  withConnectorKeyGrants,
} from "./encryptionGrant";
import { CONNECTORS } from "./registry";

// A secret saved with its own key is opened only by a grant for that exact key (TC-3284); the network grant still opens
// the older ones. The owner is spelled lowercase to prove the address is checksummed.
const LOWER = "0x4db6e7be716ba504cd103bc16b9329fe6bbe41f2";
const NETWORK = encryptionNetworkId(LOWER);

function baseManifest(): Manifest {
  return JSON.parse(readFileSync(new URL("../../../../manifest.json", import.meta.url), "utf8")) as Manifest;
}

describe("connector secret keys", () => {
  test("are exactly the keys the connector rows save, lowercased, scope in the path", () => {
    const fromRows = CONNECTORS.flatMap((connector) => connector.secretName === undefined ? [] : [
      `secrets/${connector.secretScope === undefined ? "" : `scoped/${connector.secretScope}/`}${connector.secretName.toLowerCase()}`,
    ]).sort();
    expect(CONNECTOR_SECRET_KEYS.map((entry) => entry.keyPath).sort()).toEqual(fromRows);
  });

  test("one decrypt entry each on the checksummed owner's network, never a prefix", () => {
    const grants = connectorKeyDecryptGrants(LOWER);
    expect(grants.map((grant) => grant.path)).toEqual([
      `${NETWORK}/secrets/fireflies_api_key`,
      `${NETWORK}/secrets/granola_api_key`,
      `${NETWORK}/secrets/scoped/google-meet/refresh_token`,
    ]);
    for (const grant of grants) {
      expect(grant).toMatchObject({ service: "tinycloud.encryption", actions: ["decrypt", "key.create"], skipPrefix: true });
      expect(grant.path).toContain("did:pkh:eip155:1:0x4db6e7Be716bA504Cd103BC16B9329FE6BBE41F2:default/secrets/");
      expect(grant.path.endsWith("/secrets/")).toBe(false);
    }
  });
});

describe("withConnectorKeyGrants", () => {
  test("adds the exact keys and no grant on the whole network", () => {
    const paths = (withConnectorKeyGrants(baseManifest(), LOWER).permissions ?? [])
      .filter((entry) => entry.service === "tinycloud.encryption").map((entry) => entry.path);
    expect(paths).toEqual([...connectorKeyDecryptGrants(LOWER).map((grant) => grant.path)]);
  });

  test("is idempotent", () => {
    const once = withConnectorKeyGrants(baseManifest(), LOWER);
    expect(withConnectorKeyGrants(once, LOWER)).toEqual(once);
  });
});

describe("web sign-in", () => {
  test("asks for the exact keys only once Connectors has been used on this device", () => {
    const exact = (manifest: Manifest) => (manifest.permissions ?? []).filter((entry) => String(entry.path).includes("/secrets/"));
    expect(exact(webSignInManifest(baseManifest(), [], LOWER))).toEqual([]);
    expect(exact(webSignInManifest(baseManifest(), ["connectors"], LOWER))).toHaveLength(3);
  });
});
