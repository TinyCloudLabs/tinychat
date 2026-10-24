import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolveManifest, type Manifest } from "@tinycloud/sdk-core";
import { APP_ID, CONNECTORS_SQL_DB_NAME, MEETING_DB_DETAILS, MEETING_DB_SUMMARIES, MEETING_DB_TRANSCRIPTS } from "@tinyboilerplate/core";

// The tests only read manifest.json; HOME is still a throwaway dir under /var/tmp, set at load and asserted.
const testHome = mkdtempSync("/var/tmp/tc1013.");
process.env.HOME = testHome;
if (!process.env.HOME.startsWith("/var/tmp/tc1013.")) throw new Error("HOME is not the throwaway test home");
afterAll(() => { rmSync(testHome, { recursive: true, force: true }); });

// The app's real manifest.json, resolved by the SDK's real resolveManifest: what the
// sign-in asks the node for. Revision "2" of the sign-in grants (lib/manifestRevision.ts)
// is this bundle; each entry added to it is pinned here by its resolved resource.
function appManifest(): Manifest & { permissions: Array<{ service: string; path: string; actions: string[]; skipPrefix?: boolean }> } {
  return JSON.parse(readFileSync(new URL("../../../manifest.json", import.meta.url), "utf8"));
}

const APP = APP_ID;
const SQL_ALL = ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"];

function resolved(manifest: Manifest = appManifest()) {
  return resolveManifest(manifest).resources.map(({ service, space, path, actions }) => ({ service, space, path, actions }));
}

// The grants the sign-in carried before revision 2. None of them may be narrowed or duplicated.
const EXISTING = [
  { service: "tinycloud.kv", path: `${APP}/threads/`, actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/list"] },
  { service: "tinycloud.sql", path: `${APP}/threads`, actions: SQL_ALL },
  { service: "tinycloud.sql", path: `${APP}/canvas`, actions: SQL_ALL },
  { service: "tinycloud.sql", path: `${APP}/connectors`, actions: SQL_ALL },
  { service: "tinycloud.kv", path: `${APP}/connectors/`, actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/list"] },
];

describe("manifest bundle, resolved by the real resolveManifest", () => {
  test("the three meeting databases are whole exact databases with read, write, schema", () => {
    const sql = resolved().filter((entry) => entry.service === "tinycloud.sql" && /\/(details|summaries|transcripts)$/.test(entry.path));
    expect(sql.map((entry) => entry.path).sort()).toEqual([`${APP}/details`, `${APP}/summaries`, `${APP}/transcripts`]);
    for (const entry of sql) {
      expect(entry.space).toBe("applications");
      expect(entry.actions).toEqual(SQL_ALL);
    }
  });

  test("the database name the app opens with tcw.sql.db(name) is a granted sql resource (relative entries, no prefix field)", () => {
    const manifest = appManifest();
    expect(manifest.app_id).toBe(APP);
    expect("prefix" in manifest).toBe(false);
    const granted = resolved().filter((entry) => entry.service === "tinycloud.sql").map((entry) => entry.path);
    // CONNECTORS_SQL_DB_NAME is the control: an entry that was already granted and opened the same way.
    for (const name of [CONNECTORS_SQL_DB_NAME, MEETING_DB_DETAILS, MEETING_DB_SUMMARIES, MEETING_DB_TRANSCRIPTS]) {
      expect(granted).toContain(name);
    }
    expect([MEETING_DB_DETAILS, MEETING_DB_SUMMARIES, MEETING_DB_TRANSCRIPTS]).toEqual([`${APP}/details`, `${APP}/summaries`, `${APP}/transcripts`]);
  });

  test("the cutover record folder is kv get + put only", () => {
    const entry = resolved().filter((resource) => resource.path === `${APP}/migrations/`);
    expect(entry).toEqual([{ service: "tinycloud.kv", space: "applications", path: `${APP}/migrations/`, actions: ["tinycloud.kv/get", "tinycloud.kv/put"] }]);
  });

  test("the storage info entry resolves to the bare path \"\" because skipPrefix is set", () => {
    const declared = appManifest().permissions.filter((entry) => entry.service === "tinycloud.space");
    expect(declared).toEqual([{ service: "tinycloud.space", path: "", actions: ["info"], skipPrefix: true }]);
    const entry = resolved().filter((resource) => resource.service === "tinycloud.space");
    expect(entry).toEqual([{ service: "tinycloud.space", space: "applications", path: "", actions: ["tinycloud.space/info"] }]);
  });

  test("without skipPrefix the info grant would land under the app folder (the entry would be useless)", () => {
    const manifest = appManifest();
    const info = manifest.permissions.find((entry) => entry.service === "tinycloud.space")!;
    delete info.skipPrefix;
    const entry = resolved(manifest).filter((resource) => resource.service === "tinycloud.space");
    expect(entry.map((resource) => resource.path)).toEqual([`${APP}/`]);
  });

  test("the Exo mailbox is exactly requests/ [get, list, del] and jobs/ [get, put, del] on kv", () => {
    const mailbox = resolved().filter((entry) => entry.path.startsWith(`${APP}/exo/`));
    expect(mailbox).toEqual([
      { service: "tinycloud.kv", space: "applications", path: `${APP}/exo/v1/requests/`, actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/del"] },
      { service: "tinycloud.kv", space: "applications", path: `${APP}/exo/v1/jobs/`, actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"] },
    ]);
  });

  test("no later-slice path is in the bundle", () => {
    const paths = resolved().map((entry) => entry.path);
    for (const later of ["sharing/", "handoffs/", "okf", "network"]) {
      expect(paths.filter((path) => path.includes(later))).toEqual([]);
    }
    expect(resolved().filter((entry) => entry.service === "tinycloud.encryption")).toEqual([]);
  });

  test("every grant the sign-in carried before is still there, unchanged", () => {
    const grants = resolved();
    for (const existing of EXISTING) {
      const match = grants.filter((entry) => entry.service === existing.service && entry.path === existing.path);
      expect(match).toHaveLength(1);
      expect(match[0]!.actions).toEqual(existing.actions);
    }
  });

  test("the replicated transcript folders keep an unrestricted kv get (the SDK adds kv/sync for opted-in users from it)", () => {
    const connectors = resolved().filter((entry) => entry.service === "tinycloud.kv" && entry.path === `${APP}/connectors/`);
    expect(connectors).toHaveLength(1);
    expect(connectors[0]!.actions).toContain("tinycloud.kv/get");
    expect(appManifest().permissions.flatMap((entry) => entry.actions)).not.toContain("sync");
  });

  test("no entry is duplicated and none overlaps another entry's path with a narrower action set", () => {
    const grants = resolved().filter((entry) => entry.space === "applications");
    const keys = grants.map((entry) => `${entry.service}\u0000${entry.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const inner of grants) {
      for (const outer of grants) {
        if (inner === outer || inner.service !== outer.service || !outer.path.endsWith("/") || !inner.path.startsWith(outer.path)) continue;
        // A folder entry inside another folder entry of the same service would be redundant or a narrowing.
        throw new Error(`${inner.service} ${inner.path} sits inside ${outer.path}`);
      }
    }
  });
});
