// Account erase (TC-4416) for the Courier stores on the gateway volume: grant, peers (rows and the SDK's records) and
// intake state of one owner go, another owner's stay, and nothing reaches the owner's space.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../config";
import { eraseCourierFiles } from "../courier/erase";
import { CourierIntake, courierIntakeStore } from "../courier/intake";
import type { CourierLibraryScope } from "../courier/lib-adapter";
import { createCourierPairing } from "../courier/pairing";
import { createCourierPeerStore, erasePeerFiles, type CourierPeer } from "../courier/peer-store";
import { startCourierGateway } from "../courier/runtime";
import { Gateway } from "../gateway";
import { MeetingDesk } from "../meeting-reads";
import { botIdFor } from "../owner";
import { sealedGrantStore } from "../secret-store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const KEY = new Uint8Array(32).fill(7);
const OWNER = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const OTHER = `did:pkh:eip155:1:0x${"cd".repeat(20)}`;
const peer: CourierPeer = { handle: "reader", peerDid: "did:key:zReader", status: "paired", pairedAt: 1_790_000_000_000, delegationExpiresAt: 1_790_001_000_000 };
const scopeOf = (owner: string, courierDid = "did:key:zTrustBot"): CourierLibraryScope =>
  ({ ownerDid: owner, courierDid, spaceId: `tinycloud:${owner.slice(4)}:agents`, host: "https://node.tinycloud.xyz" });
const record = { version: 1, pairingId: "challenge", phase: "pending", peer: { handle: "reader" } };
const thread = (id: string) => ({ id, threadId: "t", peer: "cli", title: "Thread", messages: [{ role: "peer" as const, text: "hello there", at: Date.now() }] });
const intakeState = { receipts: {}, rate: [], peerRates: {}, threads: { ["1".repeat(64)]: thread("1".repeat(64)) } };

/** A gateway volume holding every kind of Courier state for both owners. */
async function volume() {
  const root = mkdtempSync(join(tmpdir(), "courier-erase-")); dirs.push(root);
  const peers = createCourierPeerStore(join(root, "courier-peers"), KEY, () => peer.pairedAt);
  for (const owner of [OWNER, OTHER]) {
    await peers.put(owner, peer);
    await peers.transaction(scopeOf(owner), tx => tx.save("reader", record));
  }
  // The same owner under a second Courier identity: a second tenant directory.
  await peers.transaction(scopeOf(OWNER, "did:key:zAnotherCourier"), tx => tx.save("reader", record));
  peers.close();
  for (const owner of [OWNER, OTHER]) {
    const id = botIdFor(owner);
    sealedGrantStore(join(root, "courier-grants"), KEY).save(id, id, { owner, grant: { raw: {}, expiresAt: Date.now() + 60_000 } });
    courierIntakeStore(join(root, "courier-intake"), KEY).save(id, intakeState);
  }
  const files = (owner: string) => ({
    grant: existsSync(join(root, "courier-grants", `${botIdFor(owner)}.json`)),
    intake: existsSync(join(root, "courier-intake", `${botIdFor(owner)}.json`)),
  });
  const tenants = () => readdirSync(join(root, "courier-peers", "sdk"));
  const ownerDirs = () => readdirSync(join(root, "courier-peers")).filter(name => /^[0-9a-f]{64}$/.test(name));
  const reopen = () => createCourierPeerStore(join(root, "courier-peers"), KEY, () => peer.pairedAt);
  return { root, files, tenants, ownerDirs, reopen };
}

describe("the peer store", () => {
  test("eraseOwner removes the owner's rows and every SDK tenant bound to them, and leaves another owner's", async () => {
    const v = await volume();
    expect(v.tenants()).toHaveLength(3);
    expect(v.ownerDirs()).toHaveLength(2);
    const store = v.reopen();
    await store.eraseOwner(OWNER);
    expect(await store.list(OWNER)).toEqual([]);
    expect(await store.transaction(scopeOf(OWNER), tx => tx.get("reader"))).toBeUndefined();
    expect(await store.transaction(scopeOf(OWNER, "did:key:zAnotherCourier"), tx => tx.get("reader"))).toBeUndefined();
    expect(await store.list(OTHER)).toEqual([peer]);
    expect(await store.transaction(scopeOf(OTHER), tx => tx.get("reader"))).toEqual(record);
    expect(v.tenants()).toHaveLength(1);
    expect(v.ownerDirs()).toHaveLength(1);
    store.close();
  });

  test("the owner can start over on the same running store after an erase", async () => {
    const v = await volume();
    const store = v.reopen();
    await store.eraseOwner(OWNER);
    await store.put(OWNER, peer);
    await store.transaction(scopeOf(OWNER), tx => tx.save("reader", record));
    store.close();
    const again = v.reopen();
    expect(await again.list(OWNER)).toEqual([peer]);
    expect(await again.transaction(scopeOf(OWNER), tx => tx.get("reader"))).toEqual(record);
    again.close();
  });

  test("erasing twice, or an owner with nothing, is a no-op", async () => {
    const v = await volume();
    const store = v.reopen();
    await store.eraseOwner(OWNER);
    await store.eraseOwner(OWNER);
    await store.eraseOwner(`did:pkh:eip155:1:0x${"ef".repeat(20)}`);
    expect(v.ownerDirs()).toHaveLength(1);
    expect(v.tenants()).toHaveLength(1);
    store.close();
  });

  test("an SDK record that does not open with the seal key cannot be told apart and stays; the rows still go", async () => {
    const v = await volume();
    erasePeerFiles(join(v.root, "courier-peers"), OWNER, new Uint8Array(32).fill(9));
    expect(v.tenants()).toHaveLength(3);
    expect(v.ownerDirs()).toHaveLength(1);
  });

  test("only a well-formed owner is erased", async () => {
    const v = await volume();
    expect(() => erasePeerFiles(join(v.root, "courier-peers"), "../x", KEY)).toThrow("invalid_courier_owner");
    expect(v.ownerDirs()).toHaveLength(2);
  });
});

describe("pairing", () => {
  test("erase removes the grant first, then the peer state, and calls nothing that writes to the owner's space", async () => {
    const calls: string[] = [];
    const store = new Proxy({}, { get: (_target, name) => name === "eraseOwner" ? async () => void calls.push("peers") : () => { throw new Error(`unexpected ${String(name)}`); } });
    const grants = new Proxy({}, { get: (_target, name) => name === "delete" ? async () => void calls.push("grant") : () => { throw new Error(`unexpected ${String(name)}`); } });
    const pairing = createCourierPairing({ store: store as never, grants: grants as never });
    await pairing.erase(OWNER);
    expect(calls).toEqual(["grant", "peers"]);
  });
});

describe("intake", () => {
  function intake(dir: string, owner = OWNER) {
    const store = courierIntakeStore(dir, KEY);
    const options = {
      owners: [owner], grants: { get: async () => undefined }, peers: { list: async () => [] },
      transport: async () => { throw new Error("no peer"); }, turn: async () => { throw new Error("no turn"); },
      store, libraryReady: () => {}, log: () => {},
    };
    return new CourierIntake(options as never);
  }

  test("eraseOwner drops the threads from memory and disk, and a later pass does not save them back", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "courier-intake-erase-")), "courier-intake"); dirs.push(join(dir, ".."));
    const id = botIdFor(OWNER);
    courierIntakeStore(dir, KEY).save(id, intakeState);
    courierIntakeStore(dir, KEY).save(botIdFor(OTHER), intakeState);
    const live = intake(dir);
    expect(live.threads(OWNER)).toHaveLength(1);
    live.eraseOwner(OWNER);
    expect(live.threads(OWNER)).toEqual([]);
    expect(existsSync(join(dir, `${id}.json`))).toBe(false);
    await live.poll();
    expect(existsSync(join(dir, `${id}.json`))).toBe(false);
    expect(existsSync(join(dir, `${botIdFor(OTHER)}.json`))).toBe(true);
    live.eraseOwner(OWNER);
  });
});

describe("the gateway's Courier runtime", () => {
  function runtime(root: string) {
    const cfg: GatewayConfig = { egressRoot: "/unused", modelKey: "fixture", upstream: "https://model.test", models: ["m"], maxTokens: 100, botDailyTokens: 100, globalDailyTokens: 1000, maxBodyBytes: 4096, maxResponseBytes: 4096, connectTimeoutMs: 1000, totalTimeoutMs: 5000, bodyTimeoutMs: 1000, budgetFile: join(root, "budget.json") };
    const gateway = new Gateway(cfg, { fetch: async () => Response.json({}) });
    const reads = new MeetingDesk({ backendOrigin: "https://backend.test", backendCallSecret: "s".repeat(48), fetch: async () => Response.json({ ok: true, text: "unused" }) });
    return startCourierGateway({ cfg, gateway, reads, env: { BOTS_TEST_ACCOUNTS: [OWNER, OTHER].map(owner => owner.slice(-42)).join(",") }, sealKey: async () => KEY });
  }

  test("erase removes grant, peers, SDK records and intake state of the owner, in memory too, and no one else's", async () => {
    const v = await volume();
    const courier = await runtime(v.root);
    await courier.tick();
    await courier.erase(OWNER);
    expect(v.files(OWNER)).toEqual({ grant: false, intake: false });
    expect(v.files(OTHER)).toEqual({ grant: true, intake: true });
    expect(v.tenants()).toHaveLength(1);
    expect(v.ownerDirs()).toHaveLength(1);
    // The next pass runs for the owner without bringing anything back.
    await courier.tick();
    expect(v.files(OWNER)).toEqual({ grant: false, intake: false });
    expect(v.ownerDirs()).toHaveLength(1);
    // Repeating is allowed.
    await courier.erase(OWNER);
    courier.stop();
  });
});

describe("the files, when the Courier runtime is not running", () => {
  test("they go all the same, and the seal key is asked for only when SDK records exist", async () => {
    const v = await volume();
    let asked = 0;
    await eraseCourierFiles(v.root, OWNER, async () => { asked++; return KEY; });
    expect(asked).toBe(1);
    expect(v.files(OWNER)).toEqual({ grant: false, intake: false });
    expect(v.files(OTHER)).toEqual({ grant: true, intake: true });
    expect(v.tenants()).toHaveLength(1);
    expect(v.ownerDirs()).toHaveLength(1);
    // The owner's upper-case spelling is the same owner.
    await eraseCourierFiles(v.root, `did:pkh:eip155:1:0x${"CD".repeat(20)}`, async () => KEY);
    expect(v.files(OTHER)).toEqual({ grant: false, intake: false });
  });

  test("a volume that never had Courier state needs no key and creates nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "courier-none-")); dirs.push(root);
    mkdirSync(join(root, "keep"));
    await eraseCourierFiles(root, OWNER, async () => { throw new Error("no key expected"); });
    expect(readdirSync(root)).toEqual(["keep"]);
  });

  test("a key that cannot be had fails the erase, so the caller retries", async () => {
    const v = await volume();
    await expect(eraseCourierFiles(v.root, OWNER, async () => { throw new Error("key service down"); })).rejects.toThrow("key service down");
    expect(v.files(OWNER).grant).toBe(false);
    expect(v.tenants()).toHaveLength(3);
  });

  test("a malformed owner is refused", async () => {
    const v = await volume();
    await expect(eraseCourierFiles(v.root, "../../x", async () => KEY)).rejects.toThrow("invalid Courier owner");
    expect(v.files(OWNER)).toEqual({ grant: true, intake: true });
  });
});
