// The service's own limit on one owner's bots (TC-3325). The backend limits how many bots an owner may create; this
// holds even if that limit is wrong, so one owner cannot be announced into every place the service has.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervisorConfig } from "../config";
import { OwnerBotLimit, OwnerManifests } from "../manifest";
import { createApp } from "../server";

const tmp = mkdtempSync(join(tmpdir(), "bot-owner-limit-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const OWNER = "did:pkh:eip155:1:0x" + "22".repeat(20);
const OTHER = "did:pkh:eip155:1:0x" + "33".repeat(20);
const key = (n: number) => n.toString(16).padStart(2, "0").repeat(16);
const manifests = (limit?: number) => new OwnerManifests(join(mkdtempSync(join(tmp, "case-")), "owners"), limit);
/** An owner at a limit of 3: Main, which counts without being announced, and two more. */
function full() {
  const manifest = manifests(3);
  manifest.announce(OWNER, key(1), "active", 1);
  manifest.announce(OWNER, key(2), "suspended", 2);
  return manifest;
}

describe("the service's own limit on one owner's bots", () => {
  test("a new bot past the limit is refused, and nothing is recorded for it", () => {
    const manifest = full();
    expect(() => manifest.announce(OWNER, key(3), "active", 3)).toThrow(OwnerBotLimit);
    expect(() => manifest.announce(OWNER, key(3), "suspended", 4)).toThrow("owner_bot_limit");
    expect(manifest.stateOf(OWNER, key(3))).toBeUndefined();
    // What was there is untouched.
    expect([manifest.stateOf(OWNER, key(1)), manifest.stateOf(OWNER, key(2))]).toEqual(["active", "suspended"]);
  });

  test("a bot the service already knows is never refused an update, a deletion least of all", () => {
    const manifest = full();
    expect(manifest.announce(OWNER, key(1), "suspended", 5)).toBe("suspended");
    expect(manifest.announce(OWNER, key(1), "active", 6)).toBe("active");
    expect(manifest.announce(OWNER, "main", "suspended", 7)).toBe("suspended");
    expect(manifest.announce(OWNER, key(2), "deleting", 8)).toBe("deleting");
  });

  test("a bot that is being deleted, or is gone, no longer takes a place", () => {
    const manifest = full();
    manifest.announce(OWNER, key(2), "deleting", 5);
    expect(manifest.announce(OWNER, key(3), "active", 6)).toBe("active");
    expect(() => manifest.announce(OWNER, key(4), "active", 7)).toThrow(OwnerBotLimit);
    manifest.markRemoved(OWNER, key(2));
    expect(() => manifest.announce(OWNER, key(4), "active", 8)).toThrow(OwnerBotLimit);
  });

  test("a bot first heard of as being deleted takes no place and is not refused", () => {
    const manifest = full();
    expect(manifest.announce(OWNER, key(9), "deleting", 5)).toBe("deleting");
    expect(() => manifest.announce(OWNER, key(3), "active", 6)).toThrow(OwnerBotLimit);
  });

  test("one owner's bots do not count against another's", () => {
    const manifest = full();
    expect(manifest.announce(OTHER, key(1), "active", 1)).toBe("active");
    expect(manifest.announce(OTHER, key(2), "active", 2)).toBe("active");
    expect(() => manifest.announce(OTHER, key(3), "active", 3)).toThrow(OwnerBotLimit);
  });

  test("the limit comes from BOTS_MAX_PER_OWNER: 10 unless set, and a whole number of at least 1", () => {
    const env = (extra: Record<string, string> = {}) => ({ BOTS_SERVICE_SECRET: "s".repeat(64), ...extra });
    expect(supervisorConfig(env()).maxBotsPerOwner).toBe(10);
    expect(supervisorConfig(env({ BOTS_MAX_PER_OWNER: "4" })).maxBotsPerOwner).toBe(4);
    for (const bad of ["0", "-1", "2.5", "many"]) {
      expect(() => supervisorConfig(env({ BOTS_MAX_PER_OWNER: bad }))).toThrow("BOTS_MAX_PER_OWNER");
    }
  });

  test("over HTTP a new bot past the limit answers 409 owner_bot_limit, and a known bot is still served", async () => {
    const secret = "s".repeat(64);
    // Announcing a bot never asks for a bot's working state: this stand-in fails the test if it is touched.
    const app = createApp({ secret, accounts: "*", manifest: manifests(2), bots: { forOwner: () => { throw new Error("no bot is needed to announce one"); } } });
    const put = (botKey: string, body: unknown) => app(new Request(`http://bots.internal/v1/bots/${botKey}`, {
      method: "PUT", headers: { authorization: `Bearer ${secret}`, "x-tinycloud-owner": OWNER }, body: JSON.stringify(body),
    }));
    const first = await put(key(1), { state: "active", seq: 1 });
    expect([first.status, await first.json()]).toEqual([200, { state: "active" }]);
    const second = await put(key(2), { state: "active", seq: 2 });
    expect([second.status, await second.json()]).toEqual([409, { error: "owner_bot_limit" }]);
    const again = await put(key(1), { state: "suspended", seq: 3 });
    expect([again.status, await again.json()]).toEqual([200, { state: "suspended" }]);
  });
});
