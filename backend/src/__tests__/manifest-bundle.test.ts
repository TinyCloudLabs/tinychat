import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { resolveManifest } from "@tinycloud/node-sdk/core";
import { APP_ID, MEETING_DB_DETAILS, MEETING_DB_SUMMARIES, MEETING_DB_TRANSCRIPTS, manifestCarriesBundle } from "@tinyboilerplate/core";
import { runtimeManifest } from "../manifest.js";

// The tests only read manifest.json; HOME is still a throwaway dir under /var/tmp, set at load and asserted.
const testHome = mkdtempSync("/var/tmp/tc1013.");
process.env.HOME = testHome;
if (!process.env.HOME.startsWith("/var/tmp/tc1013.")) throw new Error("HOME is not the throwaway test home");
afterAll(() => { rmSync(testHome, { recursive: true, force: true }); });


describe("TinyChat manifest sign-in bundle", () => {

  it("resolves each entry to the resource the app opens, with the info read at the bare path", () => {
    const resources = resolveManifest(runtimeManifest()).resources;
    const grant = (service: string, path: string) => resources.filter((resource) => resource.service === service && resource.path === path);
    for (const name of [MEETING_DB_DETAILS, MEETING_DB_SUMMARIES, MEETING_DB_TRANSCRIPTS]) {
      expect(grant("tinycloud.sql", name).map((resource) => resource.actions)).toEqual([
        ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"],
      ]);
    }
    expect(grant("tinycloud.kv", "").map((resource) => resource.actions)).toEqual([["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/list", "tinycloud.kv/metadata"]]);
    expect(grant("tinycloud.kv", `${APP_ID}/exo/v1/requests/`).map((resource) => resource.actions)).toEqual([
      ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/del"],
    ]);
    expect(grant("tinycloud.kv", `${APP_ID}/exo/v1/jobs/`).map((resource) => resource.actions)).toEqual([
      ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"],
    ]);
    expect(grant("tinycloud.space", "").map((resource) => resource.actions)).toEqual([["tinycloud.space/info"]]);
    for (const name of ["xyz.tinycloud.sample.healthlog/healthlog", "xyz.tinycloud.sample.recipes/recipes"]) {
      expect(grant("tinycloud.sql", name).map((resource) => resource.actions)).toEqual([
        ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"],
      ]);
    }
  });

  it("requires every Home owner scope before treating the served manifest as current", () => {
    const current = runtimeManifest();
    expect(manifestCarriesBundle(current)).toBe(true);
    for (const [service, path] of [
      ["tinycloud.sql", "home_feed"],
      ["tinycloud.sql", "feed/"],
      ["tinycloud.hooks", `sql/${APP_ID}/feed/`],
      ["tinycloud.hooks", `sql/${APP_ID}/home_feed`],
      ["tinycloud.hooks", `sql/${APP_ID}/threads`],
    ]) {
      const missing = {
        ...current,
        permissions: current.permissions?.filter((entry) => entry.service !== service || entry.path !== path),
      };
      expect(manifestCarriesBundle(missing)).toBe(false);
    }
  });

  it("resolves Home SQL and hook authority to the exact databases the owner opens", () => {
    const resources = resolveManifest(runtimeManifest()).resources;
    for (const database of [`${APP_ID}/home_feed`, `${APP_ID}/feed/`]) {
      expect(resources.filter((resource) => resource.service === "tinycloud.sql" && resource.path === database)
        .map((resource) => resource.actions)).toEqual([
        ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"],
      ]);
    }
    expect(resources.filter((resource) => resource.service === "tinycloud.hooks")
      .map(({ path, actions }) => ({ path, actions }))).toEqual([
      { path: `sql/${APP_ID}/feed/`, actions: ["tinycloud.hooks/subscribe"] },
      { path: `sql/${APP_ID}/home_feed`, actions: ["tinycloud.hooks/subscribe"] },
      { path: `sql/${APP_ID}/threads`, actions: ["tinycloud.hooks/subscribe"] },
    ]);
  });
});
