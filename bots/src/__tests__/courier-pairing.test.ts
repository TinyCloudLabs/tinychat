import { afterEach, expect, test } from "bun:test";
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
const start = { type: "courier-pair", v: 0, step: "A", from: { owner: remoteOwner, courier: "did:key:zReader" }, spaceId: `tinycloud:pkh:eip155:1:0x${"2".repeat(40)}:agents`, peer: "trustbot", callMe: "reader", issuedAt: "2026-11-23T12:00:00.000Z" };
const final = { ...start, step: "C", delegation: "signed-peer-delegation" };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "trustbot-pairing-")); dirs.push(dir);
  const store = createCourierPeerStore(dir, new Uint8Array(32).fill(7));
  let now = Date.parse("2026-11-23T12:00:00.000Z");
  let finalized = 0;
  const adapter: PairingAdapter = {
    async context() { return {} as CourierContext; },
    async acceptPairing() {
      return {
        handle: "reader", peerDid: start.from.courier,
        artifactB: JSON.stringify({ ...start, step: "B", delegation: "signed-bot-delegation" }),
        expiresAt: now + 15 * 60_000,
      };
    },
    async finalizePairing(_ctx, pending, artifactC) {
      finalized++;
      const artifact = JSON.parse(artifactC);
      if (artifact.delegation !== "signed-peer-delegation") throw new Error("forged_signature");
      return { handle: pending.handle, peerDid: pending.peerDid, delegation: { signed: artifact.delegation }, delegationExpiresAt: now + 7 * 86_400_000 };
    },
    async unpair() {},
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
