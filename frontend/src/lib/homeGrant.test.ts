import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveManifest, validateManifest } from "@tinycloud/sdk-core";
import { HOME_CONNECTORS_ENTRIES, HOME_RECORDING_ENTRIES, HOME_SIGN_IN_BUNDLE_ENTRIES, manifestCarriesBundle } from "@tinyboilerplate/core";
import appManifest from "../../../manifest.json";
import { webAppManifestFor } from "./webSignInPrefetch";
import {
  applyManifestRevisionGate,
  manifestCarriesCurrentBundle,
  manifestRevisionFor,
  needsManifestResign,
  recordManifestRevision,
  recordManifestRevisionIfSigned,
  type RevisionStore,
} from "./manifestRevision";

const APP = "xyz.tinycloud.tinychat";
const SQL_ALL = ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"];
const KV_ALL = ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/list"];
const ADDRESS = "0x00000000000000000000000000000000000000a1";
const REVISION_KEY = `xyz.tinycloud.tinychat:manifest-revision:${ADDRESS}`;

const homeManifestJson = JSON.parse(readFileSync(new URL("../../../manifest.home.json", import.meta.url), "utf8"));

function resolved(manifest: unknown) {
  return resolveManifest(validateManifest(manifest)).resources.map(({ service, space, path, actions }) => ({ service, space, path, actions }));
}

function memoryStore(initial: Record<string, string> = {}): RevisionStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

describe("the Home site's sign-in request", () => {
  test("is exactly what Feed, Chat and Apps use", () => {
    expect(resolved(homeManifestJson)).toEqual([
      { service: "tinycloud.kv", space: "applications", path: `${APP}/threads/`, actions: KV_ALL },
      { service: "tinycloud.sql", space: "applications", path: `${APP}/threads`, actions: SQL_ALL },
      { service: "tinycloud.sql", space: "applications", path: `${APP}/home_feed`, actions: SQL_ALL },
      { service: "tinycloud.sql", space: "applications", path: `${APP}/feed/`, actions: SQL_ALL },
      { service: "tinycloud.hooks", space: "applications", path: `sql/${APP}/feed/`, actions: ["tinycloud.hooks/subscribe"] },
      { service: "tinycloud.hooks", space: "applications", path: `sql/${APP}/home_feed`, actions: ["tinycloud.hooks/subscribe"] },
      { service: "tinycloud.hooks", space: "applications", path: `sql/${APP}/threads`, actions: ["tinycloud.hooks/subscribe"] },
      { service: "tinycloud.space", space: "applications", path: "", actions: ["tinycloud.space/info"] },
      // Added by the SDK to every manifest: it lets the session read its own capabilities.
      { service: "tinycloud.capabilities", space: "applications", path: "", actions: ["tinycloud.capabilities/read"] },
    ]);
  });

  test("shares the plain build's app id so the data is the same data", () => {
    expect(homeManifestJson.app_id).toBe(appManifest.app_id);
    expect(homeManifestJson.name).toBe("TinyCloud Home");
    expect(homeManifestJson.manifest_version).toBe(appManifest.manifest_version);
    expect(homeManifestJson.defaults).toBe(appManifest.defaults);
  });

  test("carries no secrets, no decrypt, no account entries and none of the dropped databases", () => {
    expect("secrets" in homeManifestJson).toBe(false);
    const resources = resolved(homeManifestJson);
    expect(resources.filter((resource) => resource.space === "secrets")).toEqual([]);
    expect(resources.filter((resource) => resource.service === "tinycloud.encryption" || resource.path.startsWith("account/"))).toEqual([]);
    const dropped = ["canvas", "connectors", "details", "summaries", "transcripts"];
    for (const resource of resources) {
      expect(dropped.some((name) => resource.path === `${APP}/${name}` || resource.path.startsWith(`${APP}/${name}/`))).toBe(false);
      expect(resource.path.startsWith(`${APP}/exo/`)).toBe(false);
      expect(resource.path.startsWith("xyz.tinycloud.sample.")).toBe(false);
    }
    // The applications-root KV grant ("" with skipPrefix) is gone too.
    expect(resources.filter((resource) => resource.service === "tinycloud.kv" && resource.path === "")).toEqual([]);
  });

  test("the plain build's manifest keeps its full grant", () => {
    const resources = resolved(appManifest);
    expect(resources.some((resource) => resource.path === `${APP}/connectors`)).toBe(true);
    expect(resources.some((resource) => resource.path === `${APP}/transcripts`)).toBe(true);
    expect("secrets" in appManifest).toBe(true);
  });

  test("each build signs the manifest it ships", () => {
    expect(webAppManifestFor(true)).toEqual(validateManifest(homeManifestJson));
    expect(webAppManifestFor(false)).toEqual(validateManifest(appManifest));
  });
});

describe("the sets Recording and Connectors ask for on the Home site", () => {
  const SQL = ["read", "write", "schema"];
  const SECRET = ["get", "put", "del"];
  const storage = [
    { service: "tinycloud.sql", path: "connectors", actions: SQL, description: "Store meeting metadata synced from connected sources (e.g. Fireflies) in your space's SQL database." },
    { service: "tinycloud.kv", path: "connectors/", actions: ["get", "put", "del", "list"], description: "Store transcript content synced from connected sources in your space." },
  ];

  test("Recording: the meeting storage, its databases, the hosted transcription claim and the AssemblyAI key, nothing more", () => {
    expect(HOME_RECORDING_ENTRIES).toEqual([
      ...storage,
      { service: "tinycloud.sql", path: "details", actions: SQL },
      { service: "tinycloud.sql", path: "summaries", actions: SQL },
      { service: "tinycloud.sql", path: "transcripts", actions: SQL },
      // The one entry outside connectors/: the hosted transcription claim (hostedVoiceNotes.ts), read and written only.
      { service: "tinycloud.kv", space: "applications", path: "exo/voiceNotes/hostedJobs/", actions: ["get", "put"], skipPrefix: true },
      { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/ASSEMBLYAI_API_KEY", actions: SECRET, skipPrefix: true, description: "Store your transcription service API key, encrypted, in your secrets space." },
    ]);
  });

  test("Connectors: the meeting storage and the three connector keys, nothing more", () => {
    expect(HOME_CONNECTORS_ENTRIES).toEqual([
      ...storage,
      { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/FIREFLIES_API_KEY", actions: SECRET, skipPrefix: true, description: "Store your Fireflies API key, encrypted, in your secrets space." },
      { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/GRANOLA_API_KEY", actions: SECRET, skipPrefix: true, description: "Store your Granola API key, encrypted, in your secrets space." },
      { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/scoped/google-meet/REFRESH_TOKEN", actions: SECRET, skipPrefix: true, description: "Store your Google sign-in for Google Meet, encrypted, in your secrets space." },
    ]);
  });

  test("their secrets resolve to exactly what the plain build's secrets block grants", () => {
    const base = { manifest_version: 1, app_id: APP, name: "TinyCloud Home", defaults: false };
    const secretResources = (manifest: unknown) => resolved(manifest).filter((resource) => resource.space === "secrets" && resource.service !== "tinycloud.capabilities");
    const fromSets = secretResources({ ...base, permissions: [...HOME_RECORDING_ENTRIES, ...HOME_CONNECTORS_ENTRIES] });
    expect(fromSets).toHaveLength(4);
    expect(new Set(fromSets.map((resource) => JSON.stringify(resource)))).toEqual(new Set(secretResources(appManifest).map((resource) => JSON.stringify(resource))));
  });
});

describe("one re-consent for existing Home sessions", () => {
  test("revisions: Home has its own value; the plain build keeps \"4\"", () => {
    expect(manifestRevisionFor(true)).toBe("home-1");
    expect(manifestRevisionFor(false)).toBe("4");
  });

  test("the Home bundle is carried by the Home manifest and by nothing narrower", () => {
    const home = webAppManifestFor(true);
    expect(manifestCarriesBundle(home, HOME_SIGN_IN_BUNDLE_ENTRIES)).toBe(true);
    expect(manifestCarriesCurrentBundle(home, true)).toBe(true);
    for (const required of HOME_SIGN_IN_BUNDLE_ENTRIES) {
      const without = { ...home, permissions: home.permissions!.filter((entry) => !(entry.service === required.service && entry.path === required.path)) };
      expect(manifestCarriesBundle(without, HOME_SIGN_IN_BUNDLE_ENTRIES)).toBe(false);
    }
  });

  test("the plain bundle is not required of the Home manifest, and still is of the plain one", () => {
    expect(manifestCarriesBundle(webAppManifestFor(true))).toBe(false);
    expect(manifestCarriesCurrentBundle(webAppManifestFor(false), false)).toBe(true);
    expect(manifestCarriesCurrentBundle(webAppManifestFor(true), false)).toBe(false);
  });

  test("a session recorded under the broad revision is stale on Home and current on the plain build", () => {
    const store = memoryStore({ [REVISION_KEY]: "4" });
    expect(needsManifestResign(store, ADDRESS, true)).toBe(true);
    expect(needsManifestResign(store, ADDRESS, false)).toBe(false);
  });

  test("the Home gate clears the broad session once, sign-in records the Home revision, and the next restore is current", async () => {
    const store = memoryStore({ [REVISION_KEY]: "4" });
    const cleared: string[] = [];
    const gate = () => applyManifestRevisionGate({
      store,
      address: ADDRESS,
      homeSite: true,
      isOffline: () => false,
      servedManifestCarriesBundle: async () => manifestCarriesCurrentBundle(webAppManifestFor(true), true),
      handoff: async () => true,
      clearSession: (address) => { cleared.push(address); },
    });
    expect(await gate()).toBe("cleared");
    expect(cleared).toEqual([ADDRESS]);
    // The user signs in again under the Home grant.
    recordManifestRevisionIfSigned(store, ADDRESS, webAppManifestFor(true), true);
    expect(store.data.get(REVISION_KEY)).toBe("home-1");
    expect(await gate()).toBe("current");
    expect(cleared).toEqual([ADDRESS]);
  });

  test("a sign-in under a manifest without the Home bundle is not recorded as current", () => {
    const store = memoryStore({ [REVISION_KEY]: "4" });
    recordManifestRevisionIfSigned(store, ADDRESS, { permissions: [] }, true);
    expect(store.data.get(REVISION_KEY)).toBe("4");
  });

  test("the plain build records and reads \"4\" as before", () => {
    const store = memoryStore();
    expect(needsManifestResign(store, ADDRESS, false)).toBe(true);
    recordManifestRevision(store, ADDRESS, false);
    expect(store.data.get(REVISION_KEY)).toBe("4");
    expect(needsManifestResign(store, ADDRESS, false)).toBe(false);
  });
});
