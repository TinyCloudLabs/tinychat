import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCourierPeerStore, type CourierPeer } from "../courier/peer-store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const owner = `did:pkh:eip155:1:0x${"1".repeat(40)}`;
const other = `did:pkh:eip155:1:0x${"2".repeat(40)}`;
const key = new Uint8Array(32).fill(7);
const peer: CourierPeer = { handle: "reader", peerDid: "did:key:zReader", status: "paired", pairedAt: 1_790_000_000_000, delegationExpiresAt: 1_790_001_000_000 };
function directory() { const dir = mkdtempSync(join(tmpdir(), "trustbot-peers-")); dirs.push(dir); return dir; }

test("sealed peers survive restart without exposing handles or DIDs and stay owner-scoped", async () => {
  const dir = directory();
  await createCourierPeerStore(dir, key, () => peer.pairedAt).put(owner, peer);
  const store = createCourierPeerStore(dir, key, () => peer.pairedAt);
  expect(await store.list(owner)).toEqual([peer]);
  expect(await store.list(other)).toEqual([]);
  const ownerDir = join(dir, readdirSync(dir)[0]!);
  const sealed = readFileSync(join(ownerDir, readdirSync(ownerDir)[0]!), "utf8");
  expect(sealed).not.toContain(peer.handle);
  expect(sealed).not.toContain(peer.peerDid);
  expect(await createCourierPeerStore(dir, new Uint8Array(32).fill(8)).list(owner)).toEqual([]);
});

test("unpair removes the peer durably", async () => {
  const dir = directory();
  const store = createCourierPeerStore(dir, key);
  await store.put(owner, peer);
  await store.remove(owner, peer.handle);
  expect(await createCourierPeerStore(dir, key).list(owner)).toEqual([]);
  expect(await store.getRuntime(owner, peer.handle)).toBeUndefined();
});

test("pending pairings are sealed but never exposed as paired", async () => {
  const store = createCourierPeerStore(directory(), key);
  await store.putPending(owner, {
    pending: { handle: "reader", peerDid: peer.peerDid, artifactB: "accept-code", pairingId: "01J00000000000000000000000", createdAt: peer.pairedAt, expiresAt: peer.pairedAt + 900_000 },
    artifactA: "start-code", startedAt: peer.pairedAt,
  });
  expect(await store.list(owner)).toEqual([]);
  expect(await store.listRuntime(owner)).toEqual([]);
  expect((await store.getPending(owner, "reader"))?.pending.artifactB).toBe("accept-code");
});

test("damaged records and invalid peers fail closed", async () => {
  const dir = directory();
  const store = createCourierPeerStore(dir, key);
  await expect(store.put(owner, { ...peer, handle: "../escape" })).rejects.toThrow();
  await expect(store.put(owner, { ...peer, delegationExpiresAt: Infinity })).rejects.toThrow();
  await store.put(owner, peer);
  const ownerDir = join(dir, readdirSync(dir)[0]!);
  writeFileSync(join(ownerDir, readdirSync(ownerDir)[0]!), '{"v":1,"data":"damaged"}');
  expect(await store.list(owner)).toEqual([]);
});

test("late renewal cannot resurrect an unpaired peer", async () => {
  const store = createCourierPeerStore(directory(), key);
  const original = { handle: peer.handle, peerDid: peer.peerDid, delegation: { cid: "original" }, delegationExpiresAt: peer.delegationExpiresAt, proof: { cid: "original" } };
  await store.putRuntime(owner, original, peer.pairedAt);
  await store.retire(owner, peer.handle);
  expect(await store.renewRuntime(owner, original, { ...original, delegation: { cid: "successor" }, delegationExpiresAt: original.delegationExpiresAt + 60_000 })).toBe(false);
  expect(await store.list(owner)).toEqual([]);
  expect(await store.listRuntime(owner)).toEqual([]);
  expect(await store.listRetired(owner)).toEqual([original]);
});

test("expired pending cleanup retains the signed B as inactive revocation proof", async () => {
  const store = createCourierPeerStore(directory(), key);
  const pending = { pending: { handle: peer.handle, peerDid: peer.peerDid, artifactB: "signed-B", pairingId: "01J00000000000000000000000", createdAt: peer.pairedAt, expiresAt: peer.pairedAt + 900_000 }, artifactA: "A", startedAt: peer.pairedAt };
  await store.putPending(owner, pending);
  await store.retire(owner, peer.handle);
  expect(await store.getPending(owner, peer.handle)).toBeUndefined();
  expect(await store.listRuntime(owner)).toEqual([]);
  expect(await store.listRetired(owner)).toMatchObject([{ handle: peer.handle, delegation: { pending: pending.pending } }]);
});

test("finalization consumes one exact pending row and rejects the same C CID after unpair and restart", async () => {
  const dir = directory();
  const clock = () => peer.pairedAt;
  const store = createCourierPeerStore(dir, key, clock);
  const pending = { pending: { handle: peer.handle, peerDid: peer.peerDid, artifactB: "signed-B", pairingId: "01J00000000000000000000000", createdAt: peer.pairedAt, expiresAt: peer.pairedAt + 900_000 }, artifactA: "A", startedAt: peer.pairedAt };
  const runtime = { handle: peer.handle, peerDid: peer.peerDid, delegation: { signed: "C" }, proof: { cid: "used-C", issuedAt: peer.pairedAt }, delegationExpiresAt: peer.delegationExpiresAt };
  await store.putPending(owner, pending);
  expect(await store.finalizePending(owner, pending, runtime)).toBe(true);
  expect(await store.finalizePending(owner, pending, runtime)).toBe(false);
  await store.remove(owner, peer.handle);
  const restarted = createCourierPeerStore(dir, key, clock);
  const next = { ...pending, pending: { ...pending.pending, handle: "other" } };
  await restarted.putPending(owner, next);
  expect(await restarted.finalizePending(owner, next, { ...runtime, handle: "other" })).toBe(false);
  expect(await restarted.list(owner)).toEqual([]);
});
