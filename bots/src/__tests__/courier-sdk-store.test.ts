import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CourierLibraryScope } from "../courier/lib-adapter";
import { createCourierPeerStore } from "../courier/peer-store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scope: CourierLibraryScope = { ownerDid: `did:pkh:eip155:1:0x${"1".repeat(40)}`, courierDid: "did:key:zTrustBot", spaceId: `tinycloud:pkh:eip155:1:0x${"1".repeat(40)}:agents`, host: "https://node.tinycloud.xyz" };
const record = { version: 1, scope, pairingId: "challenge", phase: "pending", peer: { handle: "reader" }, artifactB: { challenge: "private-challenge" } };
function setup() { const dir = mkdtempSync(join(tmpdir(), "trustbot-sdk-store-")); dirs.push(dir); return { dir, store: createCourierPeerStore(dir, new Uint8Array(32).fill(7)) }; }

test("SDK checkpoints survive a later callback failure and a sealed restart", async () => {
  const { dir, store } = setup();
  await expect(store.transaction(scope, async tx => { await tx.save("reader", record); throw new Error("node unavailable after durable preparation"); })).rejects.toThrow("node unavailable");
  store.close();
  const restarted = createCourierPeerStore(dir, new Uint8Array(32).fill(7));
  expect(await restarted.transaction(scope, tx => tx.get("reader"))).toEqual(record);
  expect(await restarted.list(scope.ownerDid)).toEqual([]);
});

test("SDK transactions serialize competing HTTP and poll operations for the tenant", async () => {
  const { store } = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = store.transaction(scope, async tx => { entered.resolve(); await release.promise; await tx.save("reader", record); });
  await entered.promise;
  const second = store.transaction(scope, tx => tx.get("reader"));
  release.resolve();
  await first;
  expect(await second).toEqual(record);
});

test("SDK opaque state is isolated by owner, courier identity and host binding", async () => {
  const { store } = setup();
  await store.transaction(scope, tx => tx.save("reader", record));
  expect(await store.transaction({ ...scope, courierDid: "did:key:zReader" }, tx => tx.get("reader"))).toBeUndefined();
  await expect(store.transaction({ ...scope, host: "https://attacker.invalid" }, tx => tx.get("reader"))).rejects.toThrow();
  await expect(store.transaction(scope, tx => tx.save("../escape", record))).rejects.toThrow();
});

test("a damaged SDK seal fails closed rather than resetting consumed challenge state", async () => {
  const { dir, store } = setup();
  await store.transaction(scope, tx => tx.save("reader", record));
  store.close();
  const wrongKey = createCourierPeerStore(dir, new Uint8Array(32).fill(8));
  await expect(wrongKey.transaction(scope, tx => tx.get("reader"))).rejects.toThrow();
});
