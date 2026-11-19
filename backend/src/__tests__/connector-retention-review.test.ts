import { expect, test } from "bun:test";
import { ContentStore, InMemoryContentBlobStore, KvContentBlobStore, createContentIndexDirectory } from "../services/content-store.js";

const source = "fireflies", address = "0x1111111111111111111111111111111111111111";
const master = "R29vZE1hc3RlckZvckNvbnRlbnRFbnZlbG9wZXNBQTA9";
const day = 86_400_000, start = Date.parse("2026-11-12T12:00:00Z");

test("legacy expiry backfill runs once and never extends an existing expiry", async () => {
  let now = start;
  const blobs = new InMemoryContentBlobStore();
  const store = new ContentStore(blobs, { master: () => master, now: () => now, mutationGuard: { isHolder: () => true } });
  const meta = { sourceId: "legacy", storedAt: new Date(now - 365 * day).toISOString(), updatedAt: new Date(now - 365 * day).toISOString(), sizeBytes: 2 };
  await blobs.write(source, address, "legacy", (store as any).sealBlob(source, address, "legacy", JSON.stringify({meta, content: {summary: {text:"legacy"}}})));
  await (store as any).writeIndex(source, address, {meetings:[meta], tombstones:[]});
  await store.sweepRetention({source, address});
  const first = await blobs.read(source, address, "legacy");
  expect(first?.expiresAt).toBe("2026-11-25");
  expect((await store.get(source, address, "legacy"))?.meta.storedAt).toBe(meta.storedAt);
  now += day;
  await store.sweepRetention({source, address});
  expect((await blobs.read(source, address, "legacy"))?.expiresAt).toBe(first?.expiresAt);
  now = Date.parse("2026-11-25T00:00:00Z");
  expect((await store.sweepRetention({source, address})).swept).toBe(1);
});

test("a receipt that expires during index read cannot be stored", async () => {
  let now = start;
  class SlowRead extends InMemoryContentBlobStore {
    override async readIndex(s: string, a: string) { now = start + 14 * day + 1; return super.readIndex(s,a); }
  }
  const blobs = new SlowRead();
  const store = new ContentStore(blobs, { master: () => master, now: () => now });
  expect(await store.upsert({source,address,sourceId:"inflight",kind:"summary",content:{},ts:new Date(start+day).toISOString(),receivedAt:new Date(start).toISOString(),fetchedAt:new Date(start).toISOString()})).toEqual({ok:false,code:"receipt_expired"});
  expect(await blobs.read(source,address,"inflight")).toBeNull();
});

function pagedNode(loop = false) {
  const data = new Map<string, unknown>();
  const deleted: string[] = [];
  let listing: (() => void) | undefined;
  const node = {kv: {
    async list({prefix,cursor}: {prefix:string;cursor?:string}) {
      listing?.();
      const keys = [...data.keys()].filter(key => key.startsWith(prefix));
      return {ok:true,data:{keys:keys.slice(cursor ? 1 : 0,cursor ? 2 : 1),truncated:loop || (!cursor && keys.length>1),nextCursor:loop || (!cursor && keys.length>1) ? "second" : undefined}};
    },
    async get(key:string) { return data.has(key) ? {ok:true,data:{data:data.get(key)}} : null; },
    async delete(key:string) {deleted.push(key);data.delete(key);return {ok:true};},
  }};
  return {node,data,deleted,onList: (fn:()=>void) => {listing=fn;}};
}

test("owner, content, marker and purge enumeration exhaust all pages", async () => {
  const f=pagedNode(), blob={ciphertext:"sealed",wrappedDEK:"wrapped",updatedAt:new Date(start).toISOString()};
  const addressB="0x2222222222222222222222222222222222222222";
  for(const a of [address,addressB]) f.data.set(`connector-content-index/${source}/${a}`,blob);
  for(const id of ["one","two"]) f.data.set(`connector-content/${source}/${address}/${id}`,blob);
  for(const digest of ["a".repeat(64),"b".repeat(64)]) f.data.set(`connector-content-replay-tombstone/v1/${digest}`,{expiresAt:new Date(start+day).toISOString(),mac:"a".repeat(64)});
  expect(await createContentIndexDirectory(f.node as any)()).toHaveLength(2);
  const blobs=new KvContentBlobStore(f.node as any);
  expect(await blobs.listContentIds(source,address)).toHaveLength(2);
  expect(await blobs.listReplayTombstones()).toHaveLength(2);
  await blobs.removeAll(source,address,()=>{});
  expect([...f.data.keys()].filter(key=>key.startsWith(`connector-content/${source}/${address}/`))).toEqual([]);
});

test("incomplete or repeated pagination refuses cleanup", async () => {
  const f=pagedNode(true);
  await expect(createContentIndexDirectory(f.node as any)()).rejects.toThrow("cursor");
  await expect(new KvContentBlobStore(f.node as any).removeAll(source,address,()=>{})).rejects.toThrow("cursor");
  expect(f.deleted).toEqual([]);
});

test("bulk purge rechecks ownership after listing and inside each queued deletion", async () => {
  const f=pagedNode();
  f.data.set(`connector-content/${source}/${address}/one`,{});
  let held=true;
  f.onList(()=>{held=false;});
  await expect(new KvContentBlobStore(f.node as any).removeAll(source,address,()=>{if(!held)throw new Error("lease lost");})).rejects.toThrow("lease lost");
  expect(f.deleted).toEqual([]);
});

import { ConnectorFetchWorker } from "../services/fetch-worker.js";

test("the real worker refuses a receipt expired before fetch or during provider I/O", async () => {
  for (const expireBefore of [true,false]) {
    let now=start+14*day-1, calls=0, stores=0;
    const worker=new ConnectorFetchWorker({
      modes: { mode: async () => "backend" },
      fetcher: {fetchMeeting:async()=>{calls++;now=start+14*day+1;return {ok:true,content:{sourceId:"inflight",ts:new Date(now).toISOString(),payload:{}}};}},
      content:{upsert:async()=>{stores++;return {ok:true,stored:"created"};}},
    } as any,{now:()=>now,spacingMs:0});
    if(expireBefore)now+=2;
    const result=await (worker as any).processItem({source,address},"lane",{meetingId:"inflight",kind:"summary",receivedAt:new Date(start).toISOString()},{});
    expect(result.settle.lastError).toBe("receipt_expired");
    expect(stores).toBe(0);
    expect(calls).toBe(expireBefore?0:1);
  }
});

test("truncated listings without a cursor fail closed", async () => {
  const node={kv:{list:async()=>({ok:true,data:{keys:[],truncated:true}})}};
  await expect(createContentIndexDirectory(node as any)()).rejects.toThrow("cursor");
  await expect(new KvContentBlobStore(node as any).listReplayTombstones()).rejects.toThrow("cursor");
});

test("provider-date refusal applies to creation while updates keep immutable storage and expiry", async () => {
  let now=start;
  const blobs=new InMemoryContentBlobStore();
  const store=new ContentStore(blobs,{master:()=>master,now:()=>now});
  const input={source,address,sourceId:"existing",kind:"summary" as const,content:{text:"first"},ts:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),fetchedAt:new Date(now).toISOString()};
  expect(await store.upsert(input)).toEqual({ok:true,stored:"created"});
  const original=(await store.get(source,address,"existing"))!.meta;
  now+=day;
  for(const ts of [undefined,"invalid",new Date(now+5*60_000+1).toISOString()]) {
    const update={...input,ts,content:{text:"updated"},receivedAt:new Date(now).toISOString(),fetchedAt:new Date(now).toISOString()};
    expect(await store.upsert(update)).toEqual({ok:true,stored:"merged"});
    const stored=(await store.get(source,address,"existing"))!;
    expect(stored.content.summary).toEqual({text:"updated"});
    expect(stored.meta.storedAt).toBe(original.storedAt);
    expect(stored.meta.expiresAt).toBe(original.expiresAt);
    expect(await store.upsert({...update,sourceId:"new-undated"})).toEqual({ok:false,code:"meeting_time_invalid"});
    expect(await blobs.read(source,address,"new-undated")).toBeNull();
  }
});
