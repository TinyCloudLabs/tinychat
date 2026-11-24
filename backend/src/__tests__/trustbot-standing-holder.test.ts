import { expect, test } from "bun:test";
import { verifyDidKeyEd25519Signature } from "@tinycloud/sdk-core";
import { DstackStandingHolderDeriver, STANDING_HOLDER_ROOT } from "../trustbot-reads/standing-holder.js";

const owner = `did:pkh:eip155:1:0x${"a".repeat(40)}`;
const other = `did:pkh:eip155:1:0x${"b".repeat(40)}`;
const id = "approval-binding-one";
const message = Buffer.from("a scoped standing-read request");

test("derives a stable signing handle inside the scoped CVM path", async () => {
  const roots: Buffer[] = [];
  const dstack = { getKey: async (path: string) => {
    expect(path).toBe(STANDING_HOLDER_ROOT);
    const root = Buffer.alloc(32, 77);
    roots.push(root);
    return root;
  } };
  const holder = await new DstackStandingHolderDeriver(dstack).derive(owner, id, 1);
  const restored = await new DstackStandingHolderDeriver(dstack).derive(owner, id, 1);
  expect(Object.keys(holder).sort()).toEqual(["did", "sign"]);
  expect(holder.did).toBe(restored.did);
  expect(verifyDidKeyEd25519Signature(holder.did, message, await restored.sign(message))).toBe(true);
  expect(roots.every(root => root.every(byte => byte === 0))).toBe(true);
});

test("separates owners, approvals and generations without a key fallback", async () => {
  const keys = new DstackStandingHolderDeriver({ getKey: async () => Buffer.alloc(32, 77) });
  const holders = await Promise.all([
    keys.derive(owner, id, 1),
    keys.derive(other, id, 1),
    keys.derive(owner, "approval-binding-two", 1),
    keys.derive(owner, id, 2),
  ]);
  expect(new Set(holders.map(holder => holder.did)).size).toBe(4);
  await expect(keys.derive(owner.toUpperCase(), id, 1)).rejects.toThrow("invalid_standing_holder_scope");
  await expect(new DstackStandingHolderDeriver({ getKey: async () => Buffer.alloc(32) }).derive(owner, id, 1)).rejects.toThrow("standing_holder_root_unavailable");
  await expect(new DstackStandingHolderDeriver({ getKey: async () => { throw new Error("socket unavailable"); } }).derive(owner, id, 1)).rejects.toThrow("socket unavailable");
});

test("the same approval can reconstruct its public relay and uses a different link key", async () => {
  const keys = new DstackStandingHolderDeriver({ getKey: async () => Buffer.alloc(32, 79) });
  const scope = { owner, approvalId: id, generation: 1 };
  const relay = await keys.relayPublicKey(scope);
  expect(await keys.relayPublicKey(scope)).toEqual(relay);
  expect(await keys.relayPublicKey({ ...scope, generation: 2 })).not.toEqual(relay);
  const key = await keys.sealLink(scope, bytes => Buffer.from(bytes).toString("base64url"));
  expect(key).not.toBe(relay.x);
  expect(await keys.sealLink(scope, bytes => Buffer.from(bytes).toString("base64url"))).toBe(key);
});
