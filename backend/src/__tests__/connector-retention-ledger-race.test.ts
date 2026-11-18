import { expect, test } from "bun:test";
import { ConnectorControlStore, purgeLedgerKey } from "../routes/connector-webhooks.js";

test("retention pruning cannot overwrite a concurrent newer purge watermark", async () => {
  const source = "fireflies", address = "0x1111111111111111111111111111111111111111";
  const now = Date.parse("2026-11-12T12:00:00Z");
  const old = { purgedThrough: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", recentIds: ["expired"], recentIdsAddedAt: { expired: "2026-10-01T00:00:00.000Z" } };
  const newer = { purgedThrough: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), recentIds: [], recentIdsAddedAt: {} };
  const data = new Map<string, unknown>([[purgeLedgerKey(source, address), old]]);
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const node = { kv: {
    async get(key: string) { const value = data.get(key); reading.resolve(); await release.promise; return { ok: true, data: { data: value } }; },
    async put(key: string, value: unknown) { data.set(key, value); return { ok: true }; },
  }};
  const control = new ConnectorControlStore(node as any, () => now);
  const prune = control.readLedger(source, address);
  await reading.promise;
  const purge = control.writeLedger(source, address, newer);
  release.resolve();
  await Promise.all([prune, purge]);
  expect(data.get(purgeLedgerKey(source, address))).toEqual(newer);
});

import { createWebhookQueueDirectory, createWebhookPurgeLedgerDirectory } from "../services/connector-drain.js";

test("retention discovers orphaned legacy corrupt queue and purge-ledger copies", async () => {
  const source = "fireflies", address = "0x1111111111111111111111111111111111111111";
  const keys = [`webhooks/corrupt/${source}/${address}`, `webhooks/corrupt/purged/${source}/${address}`];
  const node = { kv: {
    async list({ prefix }: { prefix: string }) {
      return { ok: true, data: { keys: keys.filter(key => key.startsWith(prefix)), truncated: false } };
    },
  }};
  expect(await createWebhookQueueDirectory(node as any)()).toEqual([{ source, address }]);
  expect(await createWebhookPurgeLedgerDirectory(node as any)()).toEqual([{ source, address }]);
});

test("maintenance removes only legacy quarantine and repairs malformed live state without IDs", async () => {
  const source="fireflies", address="0x1111111111111111111111111111111111111111";
  const live=purgeLedgerKey(source,address), quarantine=`webhooks/corrupt/purged/${source}/${address}`;
  const data=new Map<string,unknown>([[live,"raw-private-id"],[quarantine,"another-private-id"]]);
  const node={kv:{
    async get(key:string){return data.has(key)?{ok:true,data:{data:data.get(key)}}:null;},
    async put(key:string,value:unknown){data.set(key,value);return {ok:true};},
    async delete(key:string){data.delete(key);return {ok:true};},
  }};
  const control=new ConnectorControlStore(node as any,()=>Date.parse("2026-11-12T12:00:00Z"));
  await control.clearQuarantinedLedger(source,address);
  expect(data.has(quarantine)).toBe(false);
  expect(data.get(live)).toBe("raw-private-id");
  await control.repairUnreadableLedger(source,address);
  const repaired=await control.readLedger(source,address);
  expect(repaired.status).toBe("ok");
  expect(JSON.stringify(data.get(live))).not.toContain("private-id");
  expect((data.get(live) as any).recentIds).toEqual([]);
  expect((data.get(live) as any).purgedThrough).toBe("9999-12-31T23:59:59.999Z");
});
