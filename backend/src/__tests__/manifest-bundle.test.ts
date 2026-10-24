import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { resolveManifest } from "@tinycloud/node-sdk/core";
import { APP_ID, MEETING_DB_DETAILS, MEETING_DB_SUMMARIES, MEETING_DB_TRANSCRIPTS, SIGN_IN_BUNDLE_ENTRIES, manifestCarriesBundle } from "@tinyboilerplate/core";
import { runtimeManifest } from "../manifest.js";

// The tests only read manifest.json; HOME is still a throwaway dir under /var/tmp, set at load and asserted.
const testHome = mkdtempSync("/var/tmp/tc1013.");
process.env.HOME = testHome;
if (!process.env.HOME.startsWith("/var/tmp/tc1013.")) throw new Error("HOME is not the throwaway test home");
afterAll(() => { rmSync(testHome, { recursive: true, force: true }); });

// The served manifest's sign-in bundle beyond the original five entries: the three meeting databases,
// the migration record folder, the storage info read and the Exo mailbox folders.
const BUNDLE = [
  { service: "tinycloud.sql", path: "details", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "summaries", actions: ["read", "write", "schema"] },
  { service: "tinycloud.sql", path: "transcripts", actions: ["read", "write", "schema"] },
  { service: "tinycloud.kv", path: "migrations/", actions: ["get", "put"] },
  { service: "tinycloud.space", path: "", actions: ["info"], skipPrefix: true },
  { service: "tinycloud.kv", path: "exo/v1/requests/", actions: ["get", "list", "del"] },
  { service: "tinycloud.kv", path: "exo/v1/jobs/", actions: ["get", "put", "del"] },
];

describe("TinyChat manifest sign-in bundle", () => {
  // The web app's revision gate reads this same list to decide whether a served or signed manifest carries
  // the bundle, so the list and the served manifest.json must not drift apart.
  it("is the list the web app's revision gate checks the served manifest against", () => {
    expect(SIGN_IN_BUNDLE_ENTRIES).toEqual(BUNDLE);
    expect(manifestCarriesBundle(runtimeManifest())).toBe(true);
  });

  it("declares the bundle entries exactly, each once", () => {
    const permissions = runtimeManifest().permissions ?? [];
    for (const entry of BUNDLE) {
      expect(permissions.filter((permission) => permission.service === entry.service && permission.path === entry.path)).toEqual([entry]);
    }
  });

  it("resolves each entry to the resource the app opens, with the info read at the bare path", () => {
    const resources = resolveManifest(runtimeManifest()).resources;
    const grant = (service: string, path: string) => resources.filter((resource) => resource.service === service && resource.path === path);
    for (const name of [MEETING_DB_DETAILS, MEETING_DB_SUMMARIES, MEETING_DB_TRANSCRIPTS]) {
      expect(grant("tinycloud.sql", name).map((resource) => resource.actions)).toEqual([
        ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"],
      ]);
    }
    expect(grant("tinycloud.kv", `${APP_ID}/migrations/`).map((resource) => resource.actions)).toEqual([["tinycloud.kv/get", "tinycloud.kv/put"]]);
    expect(grant("tinycloud.kv", `${APP_ID}/exo/v1/requests/`).map((resource) => resource.actions)).toEqual([
      ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/del"],
    ]);
    expect(grant("tinycloud.kv", `${APP_ID}/exo/v1/jobs/`).map((resource) => resource.actions)).toEqual([
      ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"],
    ]);
    expect(grant("tinycloud.space", "").map((resource) => resource.actions)).toEqual([["tinycloud.space/info"]]);
  });
});
