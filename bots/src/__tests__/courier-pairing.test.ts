import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCourierPeerStore } from "../courier/peer-store";
import { createCourierPairing, courierPeerControl, type PairingAdapter } from "../courier/pairing";
import type { CourierContext } from "../courier/lib-adapter";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const owner = `did:pkh:eip155:1:0x${"1".repeat(40)}`;
const remoteOwner = `did:pkh:eip155:1:0x${"2".repeat(40)}`;
const start = { type: "courier-pair", v: 0, step: "A", from: { owner: remoteOwner, courier: "did:key:zReader" }, spaceId: `tinycloud:pkh:eip155:1:0x${"2".repeat(40)}:agents`, peer: "trustbot", callMe: "reader", issuedAt: "2026-11-23T12:00:00.000Z", challengeVersion: 1 };
const { challengeVersion: _version, ...startFields } = start;
const final = { ...startFields, step: "C", delegation: "signed-peer-delegation", completion: { x: "x".repeat(43), signature: "s".repeat(86) } };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "trustbot-pairing-")); dirs.push(dir);
  let now = Date.parse("2026-11-23T12:00:00.000Z");
  const store = createCourierPeerStore(dir, new Uint8Array(32).fill(7), () => now);
  let finalized = 0;
  const adapter: PairingAdapter = {
    async context() { return {} as CourierContext; },
    async acceptPairing() {
      return {
        handle: "reader", peerDid: start.from.courier,
        artifactB: JSON.stringify({ ...start, step: "B", delegation: "signed-bot-delegation" }),
        pairingId: "01J00000000000000000000000", createdAt: now, expiresAt: now + 15 * 60_000,
      };
    },
    async finalizePairing(_ctx, pending, artifactC) {
      finalized++;
      const artifact = JSON.parse(artifactC);
      if (artifact.delegation !== "signed-peer-delegation") throw Object.assign(new Error("forged_signature"), { code: "bad-artifact" });
      return { handle: pending.handle, peerDid: pending.peerDid, delegation: { signed: artifact.delegation }, proof: { cid: "verified-C", issuedAt: now }, delegationExpiresAt: now + 7 * 86_400_000 };
    },
    async unpair() {},
    async renewPeer(_ctx, peer) { return peer; },
    peerReference(record) {
      const value = record as { handle?: unknown; peerDid?: unknown; pairingId?: unknown };
      if (typeof value.handle !== "string" || typeof value.peerDid !== "string" || typeof value.pairingId !== "string") throw new Error("invalid Courier peer reference");
      return { handle: value.handle, peerDid: value.peerDid, pairingId: value.pairingId };
    },
  };
  const grants = { async get() { return { raw: {}, expiresAt: now + 30 * 86_400_000 }; }, async put() {}, async delete() {} };
  const pairing = createCourierPairing({ store, grants, adapter, now: () => now });
  return { store, pairing, adapter, finalized: () => finalized, advance: (ms: number) => { now += ms; } };
}

test("A creates pending B but never a paired intake contact; C completes the same binding", async () => {
  const { pairing, store } = setup();
  const pending = await pairing.pair(owner, JSON.stringify(start));
  expect(pending).toMatchObject({ pending: true, handle: "reader", pendingExpiresAt: Date.parse(start.issuedAt) + 15 * 60_000 });
  expect(await pairing.list(owner)).toEqual([]);
  expect(await store.getRuntime(owner, "reader")).toBeUndefined();
  expect((await store.getPending(owner, "reader"))?.pending.peerDid).toBe(start.from.courier);
  const paired = await pairing.pair(owner, JSON.stringify(final));
  expect(paired).toMatchObject({ peer: { handle: "reader", status: "paired" } });
  expect(await pairing.list(owner)).toMatchObject([{ handle: "reader", status: "paired" }]);
});

test("forged final code is refused without promoting the pending contact", async () => {
  const { pairing, store } = setup();
  await pairing.pair(owner, JSON.stringify(start));
  await expect(pairing.pair(owner, JSON.stringify({ ...final, delegation: "forged" }))).rejects.toThrow();
  expect(await pairing.list(owner)).toEqual([]);
  expect((await store.getPending(owner, "reader"))?.pending.peerDid).toBe(start.from.courier);
});

test("mismatched final identities and mailbox handles are refused before activation", async () => {
  const { pairing, finalized } = setup();
  await pairing.pair(owner, JSON.stringify(start));
  for (const changed of [{ peer: "other" }, { callMe: "other" }, { from: { ...start.from, courier: "did:key:zOther" } }, { spaceId: start.spaceId.replace("2", "3") }]) {
    await expect(pairing.pair(owner, JSON.stringify({ ...final, ...changed }))).rejects.toThrow();
  }
  expect(finalized()).toBe(0);
});

test("pending pairing expires after fifteen minutes and rejects its final code", async () => {
  const { pairing, store, advance, finalized } = setup();
  await pairing.pair(owner, JSON.stringify(start));
  advance(15 * 60_000);
  await expect(pairing.pair(owner, JSON.stringify(final))).rejects.toThrow("pending_expired");
  expect(finalized()).toBe(0);
  expect(await store.getPending(owner, "reader")).toBeUndefined();
});

test("unpair removes the peer even when remote revocation is unavailable", async () => {
  const { pairing, adapter, store } = setup();
  await pairing.pair(owner, JSON.stringify(start));
  await pairing.pair(owner, JSON.stringify(final));
  adapter.unpair = async () => { throw new Error("offline"); };
  await pairing.unpair(owner, "reader");
  expect(await pairing.list(owner)).toEqual([]);
  expect(await store.getRuntime(owner, "reader")).toBeUndefined();
  expect(await store.listRetired(owner)).toMatchObject([{ handle: "reader" }]);
  await expect(pairing.pair(owner, JSON.stringify(final))).rejects.toThrow();
});

test("invalid and broader start artifacts are refused without granting a pending peer", async () => {
  const { pairing, store } = setup();
  for (const changed of [{ peer: "../other" }, { callMe: "*" }, { delegation: "unexpected_authority" }, { extraAuthority: ["tinycloud.kv/put"] }]) {
    await expect(pairing.pair(owner, JSON.stringify({ ...start, ...changed }))).rejects.toThrow();
  }
  expect(await store.listRuntime(owner)).toEqual([]);
});

test("control routes expose pending and paired responses without private grants", async () => {
  const { pairing } = setup();
  const post = (artifact: unknown) => courierPeerControl(new Request("http://gateway/courier/owner/peers", { method: "POST", body: JSON.stringify({ artifact: JSON.stringify(artifact) }) }), owner, "/peers", pairing);
  expect(await (await post(start))!.json()).toMatchObject({ pending: true });
  expect(await (await post(final))!.json()).toMatchObject({ peer: { handle: "reader" } });
  const listed = await courierPeerControl(new Request("http://gateway/courier/owner/peers"), owner, "/peers", pairing);
  const text = await listed!.text();
  expect(text).not.toContain("delegation\"");
  expect(text).not.toContain("signed-peer-delegation");
  expect((await courierPeerControl(new Request("http://gateway/courier/owner/peers/reader", { method: "DELETE" }), owner, "/peers/reader", pairing))!.status).toBe(204);
});

test("a final delegation even one millisecond over seven days is refused", async () => {
  const { pairing, adapter, store } = setup();
  await pairing.pair(owner, JSON.stringify(start));
  const finalize = adapter.finalizePairing;
  adapter.finalizePairing = async (...args) => {
    const result = await finalize(...args);
    return { ...result, delegationExpiresAt: result.delegationExpiresAt + 1 };
  };
  await expect(pairing.pair(owner, JSON.stringify(final))).rejects.toThrow("invalid");
  expect(await store.listRuntime(owner)).toEqual([]);
});

test("a pending window cannot be extended by slow node verification", async () => {
  const { pairing, adapter, advance, store } = setup();
  await pairing.pair(owner, JSON.stringify(start));
  const finalize = adapter.finalizePairing;
  adapter.finalizePairing = async (...args) => { advance(15 * 60_000); return finalize(...args); };
  await expect(pairing.pair(owner, JSON.stringify(final))).rejects.toThrow("pending_expired");
  expect(await store.listRuntime(owner)).toEqual([]);
});

test("maintenance persists a renewed peer without resetting its original pairing time", async () => {
  const { pairing, adapter, store, advance } = setup();
  await pairing.pair(owner, JSON.stringify(start));
  await pairing.pair(owner, JSON.stringify(final));
  const before = (await pairing.list(owner))[0]!;
  adapter.renewPeer = async (_ctx, peer) => ({ ...peer, delegation: { cid: "successor" }, delegationExpiresAt: peer.delegationExpiresAt + 60_000 });
  advance(60_000);
  await pairing.maintain(owner);
  expect(await pairing.list(owner)).toEqual([{ ...before, delegationExpiresAt: before.delegationExpiresAt + 60_000 }]);
  expect((await store.getRuntime(owner, "reader"))?.delegation).toEqual({ cid: "successor" });
});

test("maintenance never renews an unpaired peer", async () => {
  const { pairing, adapter } = setup();
  await pairing.pair(owner, JSON.stringify(start));
  await pairing.pair(owner, JSON.stringify(final));
  await pairing.unpair(owner, "reader");
  let renewals = 0;
  adapter.renewPeer = async (_ctx, peer) => { renewals++; return peer; };
  await pairing.maintain(owner);
  expect(renewals).toBe(0);
  expect(await pairing.list(owner)).toEqual([]);
});

test("delegation expiry is a public expired state rather than an API error", async () => {
  const { pairing, advance } = setup();
  await pairing.pair(owner, JSON.stringify(start));
  await pairing.pair(owner, JSON.stringify(final));
  advance(7 * 86_400_000);
  const response = await courierPeerControl(new Request("http://gateway/courier/owner/peers"), owner, "/peers", pairing);
  expect(response!.status).toBe(200);
  expect(await response!.json()).toMatchObject({ peers: [{ handle: "reader", status: "expired" }] });
});

test("a pending row can be finalized only once even when C is submitted concurrently", async () => {
  const { pairing } = setup();
  await pairing.pair(owner, JSON.stringify(start));
  const results = await Promise.allSettled([pairing.pair(owner, JSON.stringify(final)), pairing.pair(owner, JSON.stringify(final))]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
});

test("an unsupported peer's update-required code stays fixed at the control boundary", async () => {
  const { pairing, adapter } = setup();
  adapter.acceptPairing = async () => { throw Object.assign(new Error("private text"), { code: "courier_update_required" }); };
  const response = await courierPeerControl(new Request("http://gateway/courier/owner/peers", { method: "POST", body: JSON.stringify({ artifact: JSON.stringify(start) }) }), owner, "/peers", pairing);
  expect(response!.status).toBe(426);
  expect(await response!.json()).toEqual({ error: "courier_update_required" });
});

const stuck = { handle: "reader", peerDid: start.from.courier, pairingId: "01JSTUCK000000000000000000" };
const pairPending = () => Object.assign(new Error("private text"), { code: "pair_pending", reference: stuck });

test("an SDK attempt whose grant never activated is revoked by its exact reference, then A is accepted", async () => {
  const { pairing, adapter, store } = setup();
  const accept = adapter.acceptPairing;
  let attempts = 0;
  adapter.acceptPairing = async (ctx, artifact) => { if (attempts++ === 0) throw pairPending(); return accept(ctx, artifact); };
  const revoked: unknown[] = [];
  adapter.unpair = async (_ctx, peer) => { revoked.push(peer); };
  expect(await pairing.pair(owner, JSON.stringify(start))).toMatchObject({ pending: true, handle: "reader" });
  expect(revoked).toEqual([{ handle: "reader", peerDid: start.from.courier, delegation: { pending: stuck } }]);
  expect(attempts).toBe(2);
  expect(await store.listRetired(owner)).toEqual([]);
});

test("a pending revocation keeps the sealed reference and retries it unchanged until it succeeds", async () => {
  const { pairing, adapter, store } = setup();
  const accept = adapter.acceptPairing;
  let attempts = 0;
  adapter.acceptPairing = async (ctx, artifact) => { if (attempts++ === 0) throw pairPending(); return accept(ctx, artifact); };
  const revoked: unknown[] = [];
  let revocationPending = true;
  adapter.unpair = async (_ctx, peer) => {
    revoked.push(peer);
    if (revocationPending) throw Object.assign(new Error("private text"), { code: "unpair_pending" });
  };
  expect(await pairing.pair(owner, JSON.stringify(start)).catch(error => error)).toMatchObject({ code: "courier_unavailable", status: 503 });
  expect(attempts).toBe(1);
  expect(await store.getPending(owner, "reader")).toBeUndefined();
  // Restart: the reference survives in the sealed store, and maintenance retries the same one.
  const restarted = createCourierPairing({ store, grants: { async get() { return { raw: {}, expiresAt: Date.now() * 2 }; }, async put() {}, async delete() {} }, adapter });
  await restarted.maintain(owner);
  expect(await store.listRetired(owner)).toEqual([{ handle: "reader", peerDid: start.from.courier, delegation: { pending: stuck } }]);
  revocationPending = false;
  await restarted.maintain(owner);
  expect(await store.listRetired(owner)).toEqual([]);
  expect(revoked).toEqual(Array(3).fill({ handle: "reader", peerDid: start.from.courier, delegation: { pending: stuck } }));
});

test("an unconfirmed peer grant at finalize keeps the pending row for a retry of the same C", async () => {
  const { pairing, adapter, store } = setup();
  await pairing.pair(owner, JSON.stringify(start));
  const finalize = adapter.finalizePairing;
  adapter.finalizePairing = async () => { throw pairPending(); };
  expect(await pairing.pair(owner, JSON.stringify(final)).catch(error => error)).toMatchObject({ code: "courier_unavailable", status: 503 });
  expect((await store.getPending(owner, "reader"))?.pending.handle).toBe("reader");
  adapter.finalizePairing = finalize;
  expect(await pairing.pair(owner, JSON.stringify(final))).toMatchObject({ peer: { handle: "reader", status: "paired" } });
});

test("signed-challenge pairing is enforced before the library: old A gets 426, C without completion never verifies", async () => {
  const { pairing, adapter, store, finalized } = setup();
  let accepted = 0;
  const accept = adapter.acceptPairing;
  adapter.acceptPairing = async (ctx, artifact) => { accepted++; return accept(ctx, artifact); };
  expect(await pairing.pair(owner, JSON.stringify(startFields)).catch(error => error)).toMatchObject({ code: "courier_update_required", status: 426 });
  expect(accepted).toBe(0);
  await pairing.pair(owner, JSON.stringify(start));
  const { completion: _completion, ...unsigned } = final;
  expect(await pairing.pair(owner, JSON.stringify(unsigned)).catch(error => error)).toMatchObject({ code: "invalid", status: 400 });
  expect(finalized()).toBe(0);
  expect((await store.getPending(owner, "reader"))?.pending.handle).toBe("reader");
});

test("a C the library verified but the CAS refuses (used proof CID) is revoked by its exact reference", async () => {
  const { pairing, adapter, store } = setup();
  const revoked: unknown[] = [];
  adapter.unpair = async (_ctx, peer) => { revoked.push(peer); };
  await pairing.pair(owner, JSON.stringify(start));
  await pairing.pair(owner, JSON.stringify(final));
  await pairing.unpair(owner, "reader");
  revoked.length = 0;
  await pairing.pair(owner, JSON.stringify(start));
  expect(await pairing.pair(owner, JSON.stringify(final)).catch(error => error)).toMatchObject({ code: "invalid", status: 400 });
  expect(revoked).toEqual([{ handle: "reader", peerDid: start.from.courier, delegation: { pending: expect.objectContaining({ pairingId: "01J00000000000000000000000" }) } }]);
  expect(await pairing.list(owner)).toEqual([]);
  expect(await store.getPending(owner, "reader")).toBeUndefined();
  expect(await store.listRetired(owner)).toEqual([]);
});

test("a C verified after the pending window closed is revoked, and a failed revocation is retried by maintenance", async () => {
  const { pairing, adapter, store, advance } = setup();
  const finalize = adapter.finalizePairing;
  adapter.finalizePairing = async (ctx, pending, artifact) => { const peer = await finalize(ctx, pending, artifact); advance(16 * 60_000); return peer; };
  let failures = 1;
  const revoked: unknown[] = [];
  adapter.unpair = async (_ctx, peer) => { revoked.push(peer); if (failures-- > 0) throw new Error("node_unavailable"); };
  await pairing.pair(owner, JSON.stringify(start));
  expect(await pairing.pair(owner, JSON.stringify(final)).catch(error => error)).toMatchObject({ code: "pending_expired", status: 410 });
  expect(await store.getRuntime(owner, "reader")).toBeUndefined();
  expect(await store.listRetired(owner)).toHaveLength(1);
  await pairing.maintain(owner);
  expect(revoked).toHaveLength(2);
  expect(revoked[1]).toEqual(revoked[0]);
  expect(await store.listRetired(owner)).toEqual([]);
  expect(await pairing.list(owner)).toEqual([]);
});

test("at most ten live pending pairings per owner; the eleventh A is refused before the library", async () => {
  const { pairing, adapter, advance } = setup();
  const accept = adapter.acceptPairing;
  let accepted = 0;
  adapter.acceptPairing = async (ctx, artifact) => { accepted++; return { ...await accept(ctx, artifact), handle: JSON.parse(artifact).callMe }; };
  for (let index = 0; index < 10; index++) await pairing.pair(owner, JSON.stringify({ ...start, callMe: `reader${index}` }));
  expect(await pairing.pair(owner, JSON.stringify({ ...start, callMe: "reader10" })).catch(error => error)).toMatchObject({ code: "too_many_pending", status: 429 });
  expect(accepted).toBe(10);
  advance(15 * 60_000);
  expect(await pairing.pair(owner, JSON.stringify({ ...start, callMe: "reader10" }))).toMatchObject({ pending: true, handle: "reader10" });
});

test("a local failure while storing a library-verified C revokes it by its exact reference and leaves no live pending", async () => {
  const { pairing, adapter, store } = setup();
  const finalize = adapter.finalizePairing;
  adapter.finalizePairing = async (ctx, pending, artifact) => ({ ...await finalize(ctx, pending, artifact), proof: { cid: "" } });
  const revoked: unknown[] = [];
  adapter.unpair = async (_ctx, peer) => { revoked.push(peer); };
  await pairing.pair(owner, JSON.stringify(start));
  await expect(pairing.pair(owner, JSON.stringify(final))).rejects.toThrow("invalid_courier_proof");
  expect(revoked).toEqual([{ handle: "reader", peerDid: start.from.courier, delegation: { pending: expect.objectContaining({ pairingId: "01J00000000000000000000000" }) } }]);
  expect(await store.getPending(owner, "reader")).toBeUndefined();
  expect(await store.listRetired(owner)).toEqual([]);
  expect(await pairing.list(owner)).toEqual([]);
});

test("when the cleanup duty cannot be sealed, a verified C is revoked directly once and only a fixed outcome is logged", async () => {
  const { pairing, adapter, store } = setup();
  const finalize = adapter.finalizePairing;
  adapter.finalizePairing = async (ctx, pending, artifact) => ({ ...await finalize(ctx, pending, artifact), proof: { cid: "" } });
  const revoked: unknown[] = [];
  adapter.unpair = async (_ctx, peer) => { revoked.push(peer); };
  await pairing.pair(owner, JSON.stringify(start));
  store.retire = async () => { throw new Error("disk_full"); };
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(pairing.pair(owner, JSON.stringify(final))).rejects.toThrow("disk_full");
    expect(revoked).toEqual([{ handle: "reader", peerDid: start.from.courier, delegation: { pending: { handle: "reader", peerDid: start.from.courier, pairingId: "01J00000000000000000000000" } } }]);
    expect(log.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([
      { gateway: "courier", peer: createHash("sha256").update(start.from.courier).digest("hex").slice(0, 12), outcome: "revoked_unsealed" },
    ]);
  } finally { log.mockRestore(); }
});

test("an adapter failure after the library finalized C answers 400 and revokes the attempt by its exact reference", async () => {
  const { pairing, adapter, store } = setup();
  const finalize = adapter.finalizePairing;
  adapter.finalizePairing = async (ctx, pending, artifact) => { await finalize(ctx, pending, artifact); throw new Error("Courier stored pairing mismatch"); };
  const revoked: unknown[] = [];
  adapter.unpair = async (_ctx, peer) => { revoked.push(peer); };
  await pairing.pair(owner, JSON.stringify(start));
  expect(await pairing.pair(owner, JSON.stringify(final)).catch(error => error)).toMatchObject({ code: "invalid", status: 400 });
  expect(revoked).toEqual([{ handle: "reader", peerDid: start.from.courier, delegation: { pending: expect.objectContaining({ pairingId: "01J00000000000000000000000" }) } }]);
  expect(await store.getPending(owner, "reader")).toBeUndefined();
  expect(await store.listRetired(owner)).toEqual([]);
  expect(await pairing.list(owner)).toEqual([]);
});

test("renewal_unavailable is logged once per peer per 24 hours, not on every maintenance tick", async () => {
  const { pairing, adapter, advance } = setup();
  adapter.renewPeer = async () => { throw new Error("renewal_unavailable"); };
  await pairing.pair(owner, JSON.stringify(start));
  await pairing.pair(owner, JSON.stringify(final));
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    for (let tick = 0; tick < 5; tick++) { await pairing.maintain(owner); advance(15_000); }
    expect(log).toHaveBeenCalledTimes(1);
    advance(86_400_000);
    await pairing.maintain(owner);
    await pairing.maintain(owner);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(log.mock.calls[1]![0]))).toEqual({ gateway: "courier", peer: createHash("sha256").update(start.from.courier).digest("hex").slice(0, 12), outcome: "renewal_unavailable" });
  } finally { log.mockRestore(); }
});

test("mailbox-in-use refuses A with 409: nothing pending, nothing revoked", async () => {
  const { pairing, adapter, store } = setup();
  let revoked = 0;
  adapter.unpair = async () => { revoked++; };
  adapter.acceptPairing = async () => { throw Object.assign(new Error("An earlier grant for this Courier mailbox is still live"), { code: "mailbox-in-use" }); };
  expect(await pairing.pair(owner, JSON.stringify(start)).catch(error => error)).toMatchObject({ code: "duplicate", status: 409 });
  expect(await store.getPending(owner, "reader")).toBeUndefined();
  expect(await store.listRetired(owner)).toEqual([]);
  await pairing.maintain(owner);
  expect(revoked).toBe(0);
});

test("mailbox-unconfirmed is retryable: 503 creates no pending row, other rows stay, and the same A succeeds later", async () => {
  const { pairing, adapter, store } = setup();
  const accept = adapter.acceptPairing;
  adapter.acceptPairing = async (ctx, artifact) => ({ ...await accept(ctx, artifact), handle: JSON.parse(artifact).callMe });
  await pairing.pair(owner, JSON.stringify({ ...start, callMe: "other" }));
  adapter.acceptPairing = async () => { throw Object.assign(new Error("Courier could not confirm the mailbox is unshared"), { code: "mailbox-unconfirmed" }); };
  expect(await pairing.pair(owner, JSON.stringify(start)).catch(error => error)).toMatchObject({ code: "courier_unavailable", status: 503 });
  expect(await store.getPending(owner, "reader")).toBeUndefined();
  expect((await store.getPending(owner, "other"))?.pending.handle).toBe("other");
  adapter.acceptPairing = accept;
  expect(await pairing.pair(owner, JSON.stringify(start))).toMatchObject({ pending: true, handle: "reader" });
});

test("accepts are rate-limited per owner per hour even when no pending row is created", async () => {
  const { pairing, adapter, advance } = setup();
  let calls = 0;
  const accept = adapter.acceptPairing;
  adapter.acceptPairing = async () => { calls++; throw Object.assign(new Error("unconfirmed"), { code: "mailbox-unconfirmed" }); };
  for (let attempt = 0; attempt < 20; attempt++) expect(await pairing.pair(owner, JSON.stringify(start)).catch(error => error)).toMatchObject({ status: 503 });
  expect(await pairing.pair(owner, JSON.stringify(start)).catch(error => error)).toMatchObject({ code: "too_many_pending", status: 429 });
  expect(calls).toBe(20);
  expect(await pairing.pair(`did:pkh:eip155:1:0x${"3".repeat(40)}`, JSON.stringify(start)).catch(error => error)).toMatchObject({ status: 503 });
  advance(3_600_000);
  adapter.acceptPairing = accept;
  expect(await pairing.pair(owner, JSON.stringify(start))).toMatchObject({ pending: true, handle: "reader" });
});

test("an accepted pending the gateway rejects is revoked at once by its reference", async () => {
  const { pairing, adapter, store } = setup();
  const accept = adapter.acceptPairing;
  adapter.acceptPairing = async (ctx, artifact) => { const pending = await accept(ctx, artifact); return { ...pending, expiresAt: pending.createdAt + 16 * 60_000 }; };
  const revoked: unknown[] = [];
  adapter.unpair = async (_ctx, peer) => { revoked.push(peer); };
  expect(await pairing.pair(owner, JSON.stringify(start)).catch(error => error)).toMatchObject({ code: "invalid", status: 400 });
  expect(revoked).toEqual([{ handle: "reader", peerDid: start.from.courier, delegation: { pending: { handle: "reader", peerDid: start.from.courier, pairingId: "01J00000000000000000000000" } } }]);
  expect(await store.getPending(owner, "reader")).toBeUndefined();
  expect(await store.listRetired(owner)).toEqual([]);
});

test("maintenance revokes SDK records no local row accounts for, and leaves owned handles alone", async () => {
  const { pairing, adapter, store } = setup();
  const trustbot = "did:key:zTrustBot";
  adapter.context = async () => ({ identity: { did: trustbot } }) as unknown as CourierContext;
  const revoked: unknown[] = [];
  adapter.unpair = async (_ctx, peer) => { revoked.push(peer); };
  await pairing.pair(owner, JSON.stringify(start));
  const scope = { ownerDid: owner, courierDid: trustbot, spaceId: `tinycloud:pkh:eip155:1:0x${"1".repeat(40)}:agents`, host: "https://node.tinycloud.xyz" };
  await store.transaction(scope, async tx => {
    await tx.save("reader", { handle: "reader", peerDid: start.from.courier, pairingId: "01J00000000000000000000000" });
    await tx.save("ghost", { handle: "ghost", peerDid: "did:key:zGhost", pairingId: "ghost-attempt" });
  });
  await pairing.maintain(owner);
  expect(revoked).toEqual([{ handle: "ghost", peerDid: "did:key:zGhost", delegation: { pending: { handle: "ghost", peerDid: "did:key:zGhost", pairingId: "ghost-attempt" } } }]);
  expect((await store.getPending(owner, "reader"))?.pending.handle).toBe("reader");
  expect(await store.listRetired(owner)).toEqual([]);
});
