import { describe, expect, test } from "bun:test";
import { composeManifestRequest, resolveManifest, validateManifest, type Manifest } from "@tinycloud/sdk-core";
import { HOME_CONNECTORS_ENTRIES, HOME_RECORDING_ENTRIES } from "@tinyboilerplate/core";
import { encryptionDecryptGrant } from "./connectors/encryptionGrant";
import { webAppManifestFor } from "./webSignInPrefetch";
import { needsManifestResign, recordManifestRevisionIfSigned, type RevisionStore } from "./manifestRevision";
import {
  homeFeatureCoverageEntries,
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

  test("Recording flagged: the base, the Recording set and the decrypt grant", () => {
    expect(homeSignInManifest(base, ["recording"], ADDRESS).permissions).toEqual([...base.permissions!, ...HOME_RECORDING_ENTRIES, decrypt]);
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

  test("remembering adds a feature name once and keeps the others", () => {
    const store = memoryStore();
    rememberHomeFeature(store, ADDRESS, "connectors");
    rememberHomeFeature(store, ADDRESS, "recording");
    rememberHomeFeature(store, ADDRESS, "connectors");
    expect(JSON.parse(store.data.get(FLAG_KEY)!)).toEqual(["connectors", "recording"]);
  });

  test("an unwritable store is not an error", () => {
    const store = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(() => rememberHomeFeature(store, ADDRESS, "recording")).not.toThrow();
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
      expect(ownResources).toContainEqual(expect.objectContaining({ service: "tinycloud.encryption", path: decrypt.path, actions: ["tinycloud.encryption/decrypt"] }));
    }
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
