// Apps listed only for some accounts: the Ship ledger's tile shows only when the account's own applications space holds
// the board's key (TC-3768), and Drive's only when the owner installed it there. One metadata read each, naming no account.
import { describe, expect, test } from "bun:test";
import { listedApps, presentKeys, type ListedAppsReader } from "./listedApps";
import { ONE_APPS, oneAppsFor } from "./registry";

const LEDGER = "xyz.tinycloud.rocinante.ledger";
const MARKER = "xyz.tinycloud.rocinante/board/release-relay.json";
const DRIVE = "xyz.tinycloud.tinydrive";
// The record Drive's "Install in my TinyCloud" writes last, and the one the runner needs (runnerHost.ts readInstalledApp).
const INSTALLED = "xyz.tinycloud.tinydrive/app/install.json";
const ONLY_SOME = [LEDGER, DRIVE];

function reader(answer: (key: string) => Promise<{ ok: boolean }>) {
  const reads: string[] = [];
  const session: ListedAppsReader = { kv: { head: (key) => { reads.push(key); return answer(key); } } };
  return { session, reads };
}

describe("apps listed only for some accounts", () => {
  test("the Ledger and Drive are the only such apps, and their keys are fixed: no address, DID or space id", () => {
    const keys = ONE_APPS.flatMap((app) => (app.kind === "framed" && app.listedIf !== undefined ? [[app.id, app.listedIf]] : []));
    expect(keys).toEqual([[DRIVE, INSTALLED], [LEDGER, MARKER]]);
    for (const [, key] of keys) expect(key).not.toMatch(/0x[0-9a-f]{40}|did:|eip155|tinycloud:pkh/i);
  });

  test("Drive's key is its own install record, in its own folder", () => {
    const drive = ONE_APPS.find((app) => app.id === DRIVE)!;
    expect(drive.kind === "framed" && drive.fromSpace).toBe(true);
    expect(drive.kind === "framed" && drive.listedIf).toBe(`${DRIVE}/app/install.json`);
  });

  test("an account that holds the keys sees both; the check is one metadata read of exactly each key", async () => {
    const run = reader(async () => ({ ok: true }));
    const present = await presentKeys(run.session, ONE_APPS);
    expect(run.reads).toEqual([INSTALLED, MARKER]);
    const listed = listedApps(ONE_APPS, present).map((app) => app.id);
    for (const id of ONLY_SOME) expect(listed).toContain(id);
  });

  test("an owner who installed Drive but keeps no board sees Drive and not the Ledger", async () => {
    const present = await presentKeys(reader(async (key) => ({ ok: key === INSTALLED })).session, ONE_APPS);
    const listed = listedApps(ONE_APPS, present).map((app) => app.id);
    expect(listed).toContain(DRIVE);
    expect(listed).not.toContain(LEDGER);
  });

  test("missing, refused, offline or throwing: both stay hidden and every other app stays listed", async () => {
    for (const answer of [async () => ({ ok: false }), async () => { throw new Error("offline"); }]) {
      const present = await presentKeys(reader(answer).session, ONE_APPS);
      const listed = listedApps(ONE_APPS, present).map((app) => app.id);
      expect(listed).toEqual(ONE_APPS.map((app) => app.id).filter((id) => !ONLY_SOME.includes(id)));
    }
  });

  test("before the check answers, nothing extra is listed", () => {
    for (const platform of ["web", "ios", "android"]) {
      const apps = oneAppsFor(platform, true);
      const listed = listedApps(apps, new Set()).map((app) => app.id);
      for (const id of ONLY_SOME) expect(listed).not.toContain(id);
    }
  });
});
