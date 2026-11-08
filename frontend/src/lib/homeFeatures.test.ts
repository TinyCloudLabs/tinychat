import { describe, expect, test } from "bun:test";
import { composeManifestRequest, resolveManifest, validateManifest, type Manifest } from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "@tinycloud/node-sdk";
import { HOME_CONNECTORS_ENTRIES, HOME_RECORDING_ENTRIES } from "@tinyboilerplate/core";
import { encryptionDecryptGrant } from "./connectors/encryptionGrant";
import { webAppManifestFor } from "./webSignInPrefetch";
import { needsManifestResign, recordManifestRevisionIfSigned, type RevisionStore } from "./manifestRevision";
import {
  homeFeatureCoverageEntries,
  homeFeaturesToRequest,
  homeSignInManifest,
  readHomeFeatures,
  rememberHomeFeature,
  sessionCoversHomeFeature,
} from "./homeFeatures";

const ADDRESS = "0x00000000000000000000000000000000000000A1";
const FLAG_KEY = "xyz.tinycloud.tinychat:home-features:0x00000000000000000000000000000000000000a1";
const base = webAppManifestFor(true);
const decrypt = encryptionDecryptGrant(ADDRESS);

function memoryStore(initial: Record<string, string> = {}): RevisionStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

describe("homeSignInManifest", () => {
  test("with nothing flagged it is the base grant exactly", () => {
    expect(homeSignInManifest(base, [], ADDRESS)).toEqual(base);
  });

  test("Recording flagged: the base and the Recording set, with no decrypt grant (Recording keeps no secret)", () => {
    expect(homeSignInManifest(base, ["recording"], ADDRESS).permissions).toEqual([...base.permissions!, ...HOME_RECORDING_ENTRIES]);
  });

  test("Connectors flagged: the base, the Connectors set and the decrypt grant", () => {
    expect(homeSignInManifest(base, ["connectors"], ADDRESS).permissions).toEqual([...base.permissions!, ...HOME_CONNECTORS_ENTRIES, decrypt]);
  });

  test("both flagged: each entry once, then the decrypt grant once", () => {
    const shared = HOME_CONNECTORS_ENTRIES.filter((entry) => HOME_RECORDING_ENTRIES.includes(entry));
    expect(shared).toHaveLength(2);
    const composed = homeSignInManifest(base, ["connectors", "recording"], ADDRESS).permissions!;
    expect(composed).toEqual([
      ...base.permissions!,
      ...HOME_RECORDING_ENTRIES,
      ...HOME_CONNECTORS_ENTRIES.filter((entry) => !shared.includes(entry)),
      decrypt,
    ]);
  });

  /** The encryption abilities the SDK's sign-in builds from the grant (the sign-in and the in-place ask alike pass it as
   * the manifest): its raw abilities, where it adds network.create to any decrypt on the owner's own network. */
  const signInEncryptionAbilities = (manifest: Manifest) => {
    const authorization = new NodeUserAuthorization({ manifest, includeAccountRegistryPermissions: false, domain: "home.tinycloud.xyz",
      sessionManager: {}, wasmBindings: {} } as unknown as ConstructorParameters<typeof NodeUserAuthorization>[0]);
    const capabilities = (authorization as unknown as { resolveSignInCapabilities(address: string, chainId: number): {
      rawAbilities?: Record<string, string[]>; abilities: Record<string, string[]>; spaceAbilities: Record<string, Record<string, string[]>> } })
      .resolveSignInCapabilities(ADDRESS, 1);
    const encryption = JSON.stringify([capabilities.abilities, capabilities.spaceAbilities]).includes("tinycloud.encryption");
    expect(encryption).toBe(false);
    return capabilities.rawAbilities ?? {};
  };

  test("the SDK's sign-in request for Recording alone carries no encryption ability at all", () => {
    const raw = signInEncryptionAbilities(homeSignInManifest(base, ["recording"], ADDRESS));
    expect(Object.entries(raw).filter(([resource, actions]) => resource.includes("encryption") || actions.some((action) => action.startsWith("tinycloud.encryption")))).toEqual([]);
  });

  test("the SDK's sign-in request for Connectors, alone or with Recording, carries exactly decrypt and network.create on the owner's default network", () => {
    for (const flags of [["connectors"], ["recording", "connectors"]] as const) {
      expect(signInEncryptionAbilities(homeSignInManifest(base, flags, ADDRESS))).toEqual({
        [decrypt.path]: ["tinycloud.encryption/decrypt", "tinycloud.encryption/network.create"],
      });
    }
  });

  test("the composed grant is a valid manifest that adds no secrets block and leaves the base untouched", () => {
    const before = JSON.stringify(base);
    const composed = homeSignInManifest(base, ["recording", "connectors"], ADDRESS);
    expect(() => resolveManifest(validateManifest(composed))).not.toThrow();
    expect("secrets" in composed).toBe(false);
    expect(JSON.stringify(base)).toBe(before);
  });

  test("a sign-in under a flagged grant is recorded as \"home-1\" and the next restore is current, with no loop", () => {
    const store = memoryStore();
    recordManifestRevisionIfSigned(store, ADDRESS, homeSignInManifest(base, ["recording", "connectors"], ADDRESS), true);
    expect(store.data.get(`xyz.tinycloud.tinychat:manifest-revision:${ADDRESS.toLowerCase()}`)).toBe("home-1");
    expect(needsManifestResign(store, ADDRESS, true)).toBe(false);
  });
});

describe("the per-device feature flag", () => {
  test("is read per lowercased address, and a bad value means nothing flagged", () => {
    expect(readHomeFeatures(memoryStore({ [FLAG_KEY]: '["recording"]' }), ADDRESS)).toEqual(["recording"]);
    expect(readHomeFeatures(memoryStore({ [FLAG_KEY]: '["recording"]' }), "0x00000000000000000000000000000000000000b2")).toEqual([]);
    for (const bad of ["{not json", '"recording"', '{"recording":true}', "null"]) {
      expect(readHomeFeatures(memoryStore({ [FLAG_KEY]: bad }), ADDRESS)).toEqual([]);
    }
    expect(readHomeFeatures(memoryStore({ [FLAG_KEY]: '["recording","canvas",7,"connectors"]' }), ADDRESS)).toEqual(["recording", "connectors"]);
    expect(readHomeFeatures(null, ADDRESS)).toEqual([]);
  });

  test("bad flag JSON composes the base grant only", () => {
    expect(homeSignInManifest(base, readHomeFeatures(memoryStore({ [FLAG_KEY]: "{oops" }), ADDRESS), ADDRESS)).toEqual(base);
  });

  test("remembering adds a feature name once, keeps the others, and says it is stored", () => {
    const store = memoryStore();
    expect(rememberHomeFeature(store, ADDRESS, "connectors")).toBe(true);
    rememberHomeFeature(store, ADDRESS, "recording");
    expect(rememberHomeFeature(store, ADDRESS, "connectors")).toBe(true);
    expect(JSON.parse(store.data.get(FLAG_KEY)!)).toEqual(["connectors", "recording"]);
  });

  test("a store that refuses the write is not an error, and says nothing was stored", () => {
    const store = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(rememberHomeFeature(store, ADDRESS, "recording")).toBe(false);
  });
});

describe("whether the session covers a feature", () => {
  test("what a sign-in under a feature's grant signs names everything the check asks for; the base signs none of it", () => {
    const resources = (manifest: Manifest) => composeManifestRequest([manifest], { includeAccountRegistryPermissions: false }).resources;
    const baseResources = resources(base);
    for (const feature of ["recording", "connectors"] as const) {
      const asked = homeFeatureCoverageEntries(feature, ADDRESS);
      const signed = resources(homeSignInManifest(base, [feature], ADDRESS));
      for (const resource of asked) expect(signed).toContainEqual(resource);
      const ownResources = asked.filter((resource) => resource.service !== "tinycloud.capabilities");
      expect(ownResources.filter((resource) => baseResources.some((entry) => JSON.stringify(entry) === JSON.stringify(resource)))).toEqual([]);
    }
    // The decrypt grant is part of Connectors' check only.
    const decryptEntry = expect.objectContaining({ service: "tinycloud.encryption", path: decrypt.path, actions: ["tinycloud.encryption/decrypt"] });
    expect(homeFeatureCoverageEntries("connectors", ADDRESS)).toContainEqual(decryptEntry);
    expect(homeFeatureCoverageEntries("recording", ADDRESS).filter((resource) => resource.service === "tinycloud.encryption")).toEqual([]);
    expect(homeFeatureCoverageEntries("recording", ADDRESS)).toContainEqual(expect.objectContaining({ space: "applications", path: "exo/voiceNotes/hostedJobs/" }));
    expect(homeFeatureCoverageEntries("connectors", ADDRESS)).toContainEqual(expect.objectContaining({ space: "applications", path: "xyz.tinycloud.tinychat/connectors" }));
  });

  test("covered exactly when the session says so; a session that cannot say, or throws, does not cover it", () => {
    expect(sessionCoversHomeFeature({ hasPermissions: () => true }, "connectors", ADDRESS)).toBe(true);
    expect(sessionCoversHomeFeature({ hasPermissions: () => false }, "recording", ADDRESS)).toBe(false);
    expect(sessionCoversHomeFeature({}, "recording", ADDRESS)).toBe(false);
    expect(sessionCoversHomeFeature({ hasPermissions: () => { throw new Error("no session"); } }, "recording", ADDRESS)).toBe(false);
  });
});

describe("what a re-authorise asks for", () => {
  const coversOnly = (feature: "recording" | "connectors") => ({
    hasPermissions: (entries: unknown) => JSON.stringify(entries) === JSON.stringify(homeFeatureCoverageEntries(feature, ADDRESS)),
  });
  test("the asked feature, plus every set the session covers or this device used, so a swap never drops one", () => {
    expect(homeFeaturesToRequest(memoryStore(), coversOnly("recording"), ADDRESS, "connectors")).toEqual(["recording", "connectors"]);
    expect(homeFeaturesToRequest(memoryStore({ [FLAG_KEY]: '["connectors"]' }), {}, ADDRESS, "recording")).toEqual(["recording", "connectors"]);
    expect(homeFeaturesToRequest(memoryStore(), {}, ADDRESS, "connectors")).toEqual(["connectors"]);
  });
});
