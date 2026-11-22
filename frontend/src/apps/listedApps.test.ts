// Apps listed only for some accounts (TC-3768): the Ship ledger's tile shows only when the account's own applications
// space holds the board's key, checked with one metadata read that names no account.
import { describe, expect, test } from "bun:test";
import { listedApps, presentKeys, type ListedAppsReader } from "./listedApps";
import { ONE_APPS, oneAppsFor } from "./registry";

const LEDGER = "xyz.tinycloud.rocinante.ledger";
const MARKER = "xyz.tinycloud.rocinante/board/release-relay.json";

function reader(answer: (key: string) => Promise<{ ok: boolean }>) {
  const reads: string[] = [];
  const session: ListedAppsReader = { kv: { head: (key) => { reads.push(key); return answer(key); } } };
  return { session, reads };
}

describe("apps listed only for some accounts", () => {
  test("the Ledger is the only such app, and its key is fixed: no address, DID or space id", () => {
    const keys = ONE_APPS.flatMap((app) => (app.kind === "framed" && app.listedIf !== undefined ? [[app.id, app.listedIf]] : []));
    expect(keys).toEqual([[LEDGER, MARKER]]);
    expect(MARKER).not.toMatch(/0x[0-9a-f]{40}|did:|eip155|tinycloud:pkh/i);
  });

  test("an account that holds the key sees the Ledger; the check is one metadata read of exactly that key", async () => {
    const run = reader(async () => ({ ok: true }));
    const present = await presentKeys(run.session, ONE_APPS);
    expect(run.reads).toEqual([MARKER]);
    expect(listedApps(ONE_APPS, present).map((app) => app.id)).toContain(LEDGER);
  });

  test("missing, refused, offline or throwing: the Ledger stays hidden and every other app stays listed", async () => {
    for (const answer of [async () => ({ ok: false }), async () => { throw new Error("offline"); }]) {
      const present = await presentKeys(reader(answer).session, ONE_APPS);
      const listed = listedApps(ONE_APPS, present).map((app) => app.id);
      expect(listed).toEqual(ONE_APPS.map((app) => app.id).filter((id) => id !== LEDGER));
    }
  });

  test("before the check answers, nothing extra is listed", () => {
    for (const platform of ["web", "ios", "android"]) {
      const apps = oneAppsFor(platform, true);
      expect(listedApps(apps, new Set()).map((app) => app.id)).not.toContain(LEDGER);
    }
  });
});
