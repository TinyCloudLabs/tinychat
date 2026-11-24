import { afterEach, beforeEach, expect, test } from "bun:test";
import { composeManifestRequest } from "@tinycloud/web-sdk";
import { NodeUserAuthorization } from "@tinycloud/node-sdk";
import { encryptionDecryptGrant } from "./connectors/encryptionGrant";
import { webSignInManifest } from "./homeFeatures";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";

// The sign-in grant production web asks for once Connectors has been used (the named-key switch is on in the web build):
// what the SDK itself derives from the manifest, with no decrypt on the whole encryption network anywhere in it.

const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;
const realFlag = buildEnv[BUILD_FLAG];
const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
beforeEach(() => { buildEnv[BUILD_FLAG] = "true"; });
afterEach(() => { if (realFlag === undefined) delete buildEnv[BUILD_FLAG]; else buildEnv[BUILD_FLAG] = realFlag; });

test("web sign-in with Connectors used asks the three exact connector keys and the secrets KV, and nothing on the whole network", () => {
  const manifest = webSignInManifest(WEB_APP_MANIFEST, ["connectors"], ADDRESS);
  const network = encryptionDecryptGrant(ADDRESS).path;
  const resources = composeManifestRequest([manifest], { includeAccountRegistryPermissions: false }).resources;
  expect(resources.filter((entry) => entry.service === "tinycloud.encryption").map((entry) => entry.path).sort()).toEqual([
    `${network}/secrets/fireflies_api_key`, `${network}/secrets/granola_api_key`, `${network}/secrets/scoped/google-meet/refresh_token`,
  ]);
  expect(resources.filter((entry) => entry.space === "secrets" && entry.service === "tinycloud.kv").map((entry) => entry.path).sort()).toEqual([
    "vault/secrets/FIREFLIES_API_KEY", "vault/secrets/GRANOLA_API_KEY", "vault/secrets/scoped/google-meet/REFRESH_TOKEN",
  ]);
  const authorization = new NodeUserAuthorization({
    manifest, includeAccountRegistryPermissions: false, domain: "tinycloud.chat", sessionManager: {}, wasmBindings: {},
  } as unknown as ConstructorParameters<typeof NodeUserAuthorization>[0]);
  const capabilities = (authorization as unknown as { resolveSignInCapabilities(address: string, chainId: number): { rawAbilities?: Record<string, string[]> } })
    .resolveSignInCapabilities(ADDRESS, 1);
  expect(capabilities.rawAbilities).toEqual({
    [`${network}/secrets/fireflies_api_key`]: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"],
    [`${network}/secrets/granola_api_key`]: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"],
    [`${network}/secrets/scoped/google-meet/refresh_token`]: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"],
  });
});
