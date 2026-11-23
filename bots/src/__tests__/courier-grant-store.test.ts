import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_GRANT } from "@tinycloud/courier";
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import { courierIdentity } from "../courier/identity";
import { createCourierGrantStore } from "../courier/grant-store";
import { createCourierControl } from "../courier/control";
import { createCourierPairing } from "../courier/pairing";
import { createCourierPeerStore } from "../courier/peer-store";
import { courierContext, courierLibraryReady, CourierUnpairPending, CourierUpdateRequired, normalizeCourierError, renewPeer, sendMessage, verifiedCourierContext, type PairedPeer } from "../courier/lib-adapter";

const signingKey = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";
const dirs: string[] = [];
let fetchSpy: { mockRestore(): void } | undefined;
afterEach(() => { fetchSpy?.mockRestore(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function fixture(extra = false, days = 30) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ key: "42".repeat(32) })) as unknown as typeof fetch);
  const signer = new PrivateKeySigner(signingKey);
  const address = await signer.getAddress();
  const owner = `did:pkh:eip155:1:${address.toLowerCase()}`;
  const identity = await courierIdentity(owner);
  const wasm = new NodeWasmBindings();
  const spaceId = wasm.makeSpaceId(address, 1, "agents");
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const entry of AGENT_GRANT) (abilities[entry.service.replace("tinycloud.", "")] ??= {})[entry.path!] = entry.actions;
  if (extra) abilities.kv![""] = ["tinycloud.kv/get"];
  const expiresAt = Date.now() + days * 86_400_000;
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: "node.tinycloud.xyz", issuedAt: new Date().toISOString(), expirationTime: new Date(expiresAt).toISOString(), spaceId, jwk: identity.publicJwk });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const raw = { delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, address, chainId: 1, siwe: prepared.siwe, signature, verificationMethod: `${identity.did}#${identity.did.slice(8)}`, jwk: identity.publicJwk };
  const dir = mkdtempSync(join(tmpdir(), "courier-grant-")); dirs.push(dir);
  return { owner, grant: { raw, expiresAt }, dir, store: createCourierGrantStore(dir, new Uint8Array(32).fill(8)) };
}

test("signed exact Courier grant survives sealed restart without plaintext", async () => {
  const f = await fixture();
  await f.store.put(f.owner, f.grant);
  const restarted = createCourierGrantStore(f.dir, new Uint8Array(32).fill(8));
  expect((await restarted.get(f.owner))?.expiresAt).toBe(f.grant.expiresAt);
  const bytes = readFileSync(join(f.dir, readdirSync(f.dir)[0]!), "utf8");
  expect(bytes).not.toContain(f.grant.raw.signature);
  expect(bytes).not.toContain(f.grant.raw.siwe);
  await restarted.delete(f.owner);
  expect(await restarted.get(f.owner)).toBeUndefined();
});

test("broader signed owner authority is refused", async () => {
  const f = await fixture(true);
  await expect(f.store.put(f.owner, f.grant)).rejects.toThrow();
  expect(await f.store.get(f.owner)).toBeUndefined();
});

test("longer signed owner authority is refused", async () => {
  const f = await fixture(false, 31);
  await expect(f.store.put(f.owner, f.grant)).rejects.toThrow();
});

test("forged expiry and foreign owner cannot install signed grant", async () => {
  const f = await fixture();
  await expect(f.store.put(f.owner, { ...f.grant, expiresAt: f.grant.expiresAt + 1 })).rejects.toThrow();
  await expect(f.store.put(`did:pkh:eip155:1:0x${"11".repeat(20)}`, f.grant)).rejects.toThrow();
});

test("damaged sealed records fail closed", async () => {
  const f = await fixture();
  await f.store.put(f.owner, f.grant);
  const file = join(f.dir, readdirSync(f.dir)[0]!);
  writeFileSync(file, "{broken");
  expect(await f.store.get(f.owner)).toBeUndefined();
});

test("gateway Courier setup exports only public identity and finite grant metadata", async () => {
  const f = await fixture();
  const control = createCourierControl(f.store, () => {});
  const url = `http://gateway/courier/${encodeURIComponent(f.owner)}`;
  const identity = await (await control(new Request(`${url}/identity`)))!.json();
  expect(identity.did).toBe(f.grant.raw.verificationMethod.split("#")[0]);
  expect(identity.publicJwk).toEqual(f.grant.raw.jwk);
  expect(identity).not.toHaveProperty("signer");
  expect(identity.publicJwk).not.toHaveProperty("d");
  expect(identity.request.permissions).toEqual(AGENT_GRANT);
  expect(identity.request.expiry).toBe("30d");
  const put = await control(new Request(`${url}/grant`, { method: "PUT", body: JSON.stringify(f.grant) }));
  expect(put?.status).toBe(200);
  expect(await put!.json()).toEqual({ expiresAt: f.grant.expiresAt });
  const get = await control(new Request(`${url}/grant`));
  expect(await get!.json()).toEqual({ expiresAt: f.grant.expiresAt });
  expect((await control(new Request(`${url}/grant`, { method: "DELETE" })))?.status).toBe(204);
  expect(await (await control(new Request(`${url}/grant`)))!.json()).toEqual({ expiresAt: null });
});

test("a tampered owner signature is refused before sealing", async () => {
  const f = await fixture();
  await expect(f.store.put(f.owner, { ...f.grant, raw: { ...f.grant.raw, signature: `0x${"11".repeat(65)}` } })).rejects.toThrow();
  expect(await f.store.get(f.owner)).toBeUndefined();
});

/** A library without the headless API, checked by the real gate. */
const notReady = () => courierLibraryReady({});

test("the pinned Courier library carries the headless API, so the library gate passes", () => {
  expect(() => courierLibraryReady()).not.toThrow();
  expect(notReady).toThrow(CourierUpdateRequired);
});

test("a library without the headless API refuses the context before restoring any grant session", async () => {
  const f = await fixture();
  const restore = spyOn(TinyCloudNode.prototype, "restoreSession");
  let opened = 0;
  try {
    await expect(courierContext(f.owner, f.grant, { async transaction(_s, op) { opened++; return op({ async get() { return undefined; }, async save() {} }); } }, notReady))
      .rejects.toMatchObject({ code: "courier_update_required" });
    expect(restore).not.toHaveBeenCalled();
    expect(opened).toBe(0);
  } finally {
    restore.mockRestore();
  }
});

test("on a library without the headless API, grant reads and writes and pairing restore no session", async () => {
  const f = await fixture();
  await f.store.put(f.owner, f.grant);
  const restore = spyOn(TinyCloudNode.prototype, "restoreSession");
  try {
    const control = createCourierControl(f.store, notReady);
    const url = `http://gateway/courier/${encodeURIComponent(f.owner)}/grant`;
    for (const init of [{}, { method: "PUT", body: JSON.stringify(f.grant) }]) {
      const response = (await control(new Request(url, init)))!;
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual({ error: "courier_update_required" });
    }
    let lookups = 0;
    const grants = { async get() { lookups++; return f.grant; }, async put() {}, async delete() {} };
    const dir = mkdtempSync(join(tmpdir(), "courier-peers-")); dirs.push(dir);
    const pairing = createCourierPairing({ store: createCourierPeerStore(dir, new Uint8Array(32).fill(9)), grants, libraryReady: notReady });
    const start = {
      type: "courier-pair", v: 0, step: "A", from: { owner: `did:pkh:eip155:1:0x${"2".repeat(40)}`, courier: "did:key:zReader" },
      spaceId: `tinycloud:pkh:eip155:1:0x${"2".repeat(40)}:agents`, peer: "trustbot", callMe: "reader", issuedAt: new Date().toISOString(), challengeVersion: 1,
    };
    await expect(pairing.pair(f.owner, JSON.stringify(start))).rejects.toMatchObject({ code: "courier_update_required" });
    expect(lookups).toBe(0);
    expect(restore).not.toHaveBeenCalled();
  } finally {
    restore.mockRestore();
  }
});

test("the context handed to the library holds only the courier-key session restored from the agent grant", async () => {
  const f = await fixture();
  const store = { async transaction<T>(_s: unknown, op: (tx: never) => Promise<T>) { return op({} as never); } };
  const context = await verifiedCourierContext(f.owner, f.grant, store);
  // courierContext's kv is passed to every headless call verbatim; no owner-primary session or ambient fetch rides along.
  const handed = context.kv as Record<string, unknown>;
  expect(Object.keys(handed).sort()).toEqual(["courierDid", "createReader", "host", "node", "ownerDid", "store"]);
  expect(handed.courierDid).toBe(context.identity.did);
  expect(handed.store).toBe(store);
  type Restored = { restorableSession: { delegationCid: string; jwk?: { x?: string } } };
  const node = handed.node as Restored;
  expect(node.restorableSession.delegationCid).toBe(f.grant.raw.delegationCid);
  expect(node.restorableSession.jwk?.x).toBe(context.identity.publicJwk.x);
  const reader = (await (handed.createReader as () => Promise<unknown>)()) as Restored;
  expect(reader).not.toBe(node);
  expect(reader.restorableSession.delegationCid).toBe(f.grant.raw.delegationCid);
});

test("renewal is a typed refusal and replies must carry the bound idempotency key", async () => {
  const f = await fixture();
  const context = await verifiedCourierContext(f.owner, f.grant, { async transaction(_s, op) { return op({ async get() { return undefined; }, async save() {} }); } });
  const ref = { handle: "peer", peerDid: "did:key:zPeer", pairingId: "p1" };
  const peer: PairedPeer = { handle: ref.handle, peerDid: ref.peerDid, delegationExpiresAt: Date.now() + 86_400_000, proof: { cid: "bafy" }, delegation: { ref, record: {} } };
  await expect(renewPeer(context, peer)).rejects.toMatchObject({ code: "renewal_unavailable" });
  await expect(sendMessage(context, peer, "t1", "hi", { inReplyTo: "m1", idempotencyKey: "0".repeat(64) })).rejects.toThrow("invalid Courier reply binding");
});

test("the library's hyphenated refusals reach callers as single typed errors", () => {
  const mapped = normalizeCourierError(Object.assign(new Error("pre-challenge pair artifact"), { code: "courier-update-required" }));
  expect(mapped).toBeInstanceOf(CourierUpdateRequired);
  expect(mapped).toMatchObject({ code: "courier_update_required" });
  const unpair = normalizeCourierError(Object.assign(new Error("cleanup incomplete"), { code: "unpair-pending" }));
  expect(unpair).toBeInstanceOf(CourierUnpairPending);
  expect(unpair).toMatchObject({ code: "unpair_pending" });
  const other = Object.assign(new Error("bad signature"), { code: "bad-delegation" });
  expect(normalizeCourierError(other)).toBe(other);
});
