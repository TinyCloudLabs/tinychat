import { describe, expect, test } from "bun:test";
import { composeManifestRequest, resolveManifest, validateManifest, type Manifest } from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "@tinycloud/node-sdk";
import { encryptionDecryptGrant } from "./connectors/encryptionGrant";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";
import {
  homeFeatureCoverageEntries,
  homeFeaturesToRequest,
  readHomeFeatures,
  rememberHomeFeature,
  sessionCoversHomeFeature,
  webSignInManifest,
} from "./homeFeatures";

const ADDRESS = "0x00000000000000000000000000000000000000A1";
const FLAG_KEY = "xyz.tinycloud.tinychat:home-features:0x00000000000000000000000000000000000000a1";
const base = WEB_APP_MANIFEST;
const decrypt = encryptionDecryptGrant(ADDRESS);

function memoryStore(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

/** The encryption abilities the SDK's sign-in builds from the grant: its raw abilities, where it adds network.create
 * to any decrypt on the owner's own network. */
const signInRawAbilities = (manifest: Manifest) => {
  const authorization = new NodeUserAuthorization({ manifest, includeAccountRegistryPermissions: false, domain: "tinycloud.chat",
    sessionManager: {}, wasmBindings: {} } as unknown as ConstructorParameters<typeof NodeUserAuthorization>[0]);
  const capabilities = (authorization as unknown as { resolveSignInCapabilities(address: string, chainId: number): {
    rawAbilities?: Record<string, string[]>; abilities: Record<string, string[]>; spaceAbilities: Record<string, Record<string, string[]>> } })
    .resolveSignInCapabilities(ADDRESS, 1);
  expect(JSON.stringify([capabilities.abilities, capabilities.spaceAbilities]).includes("tinycloud.encryption")).toBe(false);
  return capabilities.rawAbilities ?? {};
};

describe("webSignInManifest", () => {
  test("a fresh sign-in (nothing flagged) has no encryption entry, empty secrets, and asks no secrets KV, decrypt or network.create", () => {
    const manifest = webSignInManifest(base, [], ADDRESS);
    expect(manifest).toEqual({ ...base, secrets: {} });
    expect(manifest.permissions!.filter((entry) => entry.service === "tinycloud.encryption")).toEqual([]);
    const resources = composeManifestRequest([manifest], { includeAccountRegistryPermissions: false }).resources;
    expect(resources.filter((entry) => entry.space === "secrets")).toEqual([]);
    expect(resources.filter((entry) => entry.service === "tinycloud.encryption")).toEqual([]);
    expect(signInRawAbilities(manifest)).toEqual({});
  });

  test("Connectors flagged: the base and the decrypt grant, and the SDK asks exactly decrypt and network.create on the owner's default network", () => {
    const manifest = webSignInManifest(base, ["connectors"], ADDRESS);
    expect(manifest.permissions).toEqual([...base.permissions!, decrypt]);
    expect(signInRawAbilities(manifest)).toEqual({
      [decrypt.path]: ["tinycloud.encryption/decrypt", "tinycloud.encryption/network.create"],
    });
  });

  test("the composed grant is a valid manifest and leaves the base untouched", () => {
    const before = JSON.stringify(base);
    for (const flags of [[], ["connectors"]] as const) {
      expect(() => resolveManifest(validateManifest(webSignInManifest(base, flags, ADDRESS)))).not.toThrow();
    }
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("the per-device feature flag", () => {
  test("is read per lowercased address, and a bad value means nothing flagged", () => {
    expect(readHomeFeatures(memoryStore({ [FLAG_KEY]: '["connectors"]' }), ADDRESS)).toEqual(["connectors"]);
    expect(readHomeFeatures(memoryStore({ [FLAG_KEY]: '["connectors"]' }), "0x00000000000000000000000000000000000000b2")).toEqual([]);
    for (const bad of ["{not json", '"connectors"', '{"connectors":true}', "null"]) {
      expect(readHomeFeatures(memoryStore({ [FLAG_KEY]: bad }), ADDRESS)).toEqual([]);
    }
    expect(readHomeFeatures(memoryStore({ [FLAG_KEY]: '["canvas",7,"connectors"]' }), ADDRESS)).toEqual(["connectors"]);
    expect(readHomeFeatures(null, ADDRESS)).toEqual([]);
  });

  test("a legacy \"recording\" flag is ignored", () => {
    expect(readHomeFeatures(memoryStore({ [FLAG_KEY]: '["recording"]' }), ADDRESS)).toEqual([]);
    expect(readHomeFeatures(memoryStore({ [FLAG_KEY]: '["recording","connectors"]' }), ADDRESS)).toEqual(["connectors"]);
  });

  test("bad flag JSON composes the fresh web sign-in grant", () => {
    expect(webSignInManifest(base, readHomeFeatures(memoryStore({ [FLAG_KEY]: "{oops" }), ADDRESS), ADDRESS)).toEqual({ ...base, secrets: {} });
  });

  test("remembering adds a feature name once and says it is stored", () => {
    const store = memoryStore();
    expect(rememberHomeFeature(store, ADDRESS, "connectors")).toBe(true);
    expect(rememberHomeFeature(store, ADDRESS, "connectors")).toBe(true);
    expect(JSON.parse(store.data.get(FLAG_KEY)!)).toEqual(["connectors"]);
  });

  test("a store that refuses the write is not an error, and says nothing was stored", () => {
    const store = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(rememberHomeFeature(store, ADDRESS, "connectors")).toBe(false);
    expect(rememberHomeFeature(null, ADDRESS, "connectors")).toBe(false);
  });
});

describe("whether the session covers Connectors", () => {
  test("a sign-in after Connectors was used signs everything the check asks for; a fresh sign-in misses the secrets and decrypt", () => {
    const resources = (manifest: Manifest) => composeManifestRequest([manifest], { includeAccountRegistryPermissions: false }).resources;
    const asked = homeFeatureCoverageEntries("connectors", ADDRESS);
    const signed = resources(webSignInManifest(base, ["connectors"], ADDRESS));
    for (const resource of asked) expect(signed).toContainEqual(expect.objectContaining(resource));
    const fresh = resources(webSignInManifest(base, [], ADDRESS));
    const missing = asked.filter((resource) => !fresh.some((entry) => entry.service === resource.service && entry.space === resource.space && entry.path === resource.path));
    expect(missing.some((resource) => resource.service === "tinycloud.encryption")).toBe(true);
    expect(missing.filter((resource) => resource.space === "secrets" && resource.service === "tinycloud.kv").map((resource) => resource.path).sort()).toEqual([
      "vault/secrets/FIREFLIES_API_KEY", "vault/secrets/GRANOLA_API_KEY", "vault/secrets/scoped/google-meet/REFRESH_TOKEN",
    ]);
    expect(asked).toContainEqual(expect.objectContaining({ service: "tinycloud.encryption", path: decrypt.path, actions: ["tinycloud.encryption/decrypt"] }));
    expect(asked).toContainEqual(expect.objectContaining({ space: "applications", path: "xyz.tinycloud.tinychat/connectors" }));
  });

  test("covered exactly when the session says so; a session that cannot say, or throws, does not cover it", () => {
    expect(sessionCoversHomeFeature({ hasPermissions: () => true }, "connectors", ADDRESS)).toBe(true);
    expect(sessionCoversHomeFeature({ hasPermissions: () => false }, "connectors", ADDRESS)).toBe(false);
    expect(sessionCoversHomeFeature({}, "connectors", ADDRESS)).toBe(false);
    expect(sessionCoversHomeFeature({ hasPermissions: () => { throw new Error("no session"); } }, "connectors", ADDRESS)).toBe(false);
  });
});

describe("what a re-authorise asks for", () => {
  test("Connectors, whether or not it was flagged or covered", () => {
    expect(homeFeaturesToRequest(memoryStore(), {}, ADDRESS, "connectors")).toEqual(["connectors"]);
    expect(homeFeaturesToRequest(memoryStore({ [FLAG_KEY]: '["connectors"]' }), { hasPermissions: () => true }, ADDRESS, "connectors")).toEqual(["connectors"]);
  });
});
