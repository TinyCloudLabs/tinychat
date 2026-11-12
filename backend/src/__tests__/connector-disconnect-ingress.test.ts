import { expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import { ConnectorQueue } from "../services/connector-queue.js";
import { ConnectorControlStore, disabledMarkerKey, purgeLedgerKey } from "../routes/connector-webhooks.js";
import { ConnectorTeardownService } from "../services/connector-teardown.js";
import { WebhookTokenService } from "../services/webhook-tokens.js";
import { createConnectorCredentialRouter } from "../routes/connector-credentials.js";
import { ContentStore, InMemoryContentBlobStore } from "../services/content-store.js";

const source="fireflies", address="0x1111111111111111111111111111111111111111";
const other="0x2222222222222222222222222222222222222222";
const initial=Date.parse("2026-11-12T12:00:00Z"), day=86_400_000;
function storage() {
  const data=new Map<string,unknown>();
  const node={kv:{
    async get(key:string){return data.has(key)?{ok:true,data:{data:data.get(key)}}:null;},
    async put(key:string,value:unknown){data.set(key,value);return {ok:true};},
    async delete(key:string){data.delete(key);return {ok:true};},
  }};
  return {data,node};
}

// No sleeps: pause a flush after it read "enabled", then disable and clear under its owner lock.
test("OFF clears a flush already past its marker check and drops later in-flight handlers", async () => {
  const f=storage(), control=new ConnectorControlStore(f.node as any,()=>initial);
  const checked=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
  let pause=true;
  const queue=new ConnectorQueue(f.node as any,{now:()=>initial,flushWindowMs:0,isDisabled:async owner=>{
    const disabled=(await control.readDisabled(owner))!==null;
    if(pause){pause=false;checked.resolve();await release.promise;}
    return disabled;
  }});
  const earlier=queue.enqueue(source,address,{meetingId:"earlier",kind:"summary"});
  await checked.promise;
  await control.markDisabled(address,source);
  const clear=queue.clear(source,address);
  release.resolve();
  await earlier;
  await clear;
  // Represents an HTTP handler that authenticated its callback token before OFF completed.
  expect(await queue.enqueue(source,address,{meetingId:"late-handler",kind:"summary"})).toEqual({status:"dropped",depth:0});
  expect(await queue.list(source,address)).toEqual([]);
  expect([...f.data.keys()].filter(key=>key.startsWith("webhooks/pending/")||key.startsWith("webhooks/dead/"))).toEqual([]);
});

test("an unreadable disabled marker refuses enqueue without storing an ID", async () => {
  const f=storage();
  const queue=new ConnectorQueue(f.node as any,{now:()=>initial,flushWindowMs:0,isDisabled:async()=>{throw new Error("storage unavailable");}});
  await expect(queue.enqueue(source,address,{meetingId:"refused",kind:"summary"})).rejects.toThrow("storage unavailable");
  expect(f.data.size).toBe(0);
});

test("DELETE credentials disables notifications, revokes cached callbacks, and timestamps IDs through their lifetime", async () => {
  let now=initial;
  const f=storage(), tokens=new WebhookTokenService(f.node as any), control=new ConnectorControlStore(f.node as any,()=>now);
  const callback="a".repeat(43), otherCallback="b".repeat(43);
  for(const [owner,token] of [[address,callback],[other,otherCallback]]) {
    f.data.set(`webhooks/config/${owner}`,{source,token,createdAt:new Date(now).toISOString()});
    f.data.set(`webhooks/tokens/${token}`,{source,address:owner,createdAt:new Date(now).toISOString()});
  }
  expect(await tokens.lookup(callback)).not.toBeNull(); // Prime the positive cache.
  const queue=new ConnectorQueue(f.node as any,{now:()=>now,flushWindowMs:0,isDisabled:async owner=>(await control.readDisabled(owner))!==null});
  await queue.enqueue(source,address,{meetingId:"waiting",kind:"summary"});
  const content=new ContentStore(new InMemoryContentBlobStore(),{now:()=>now,master:()=>"R29vZE1hc3RlckZvckNvbnRlbnRFbnZlbG9wZXNBQTA9"});
  await content.upsert({source,address,sourceId:"saved",kind:"summary",content:{text:"meeting"},ts:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),fetchedAt:new Date(now).toISOString()});
  const oldStamp=new Date(now-day).toISOString();
  await control.writeLedger(source,address,{purgedThrough:oldStamp,recentIds:["older"],recentIdsAddedAt:{older:oldStamp},updatedAt:oldStamp});
  let revoked=0;
  const credentials={revoke:async()=>{revoked++;return {deleted:true as const,upstreamRevoked:"ok" as const};}};
  const teardown=new ConnectorTeardownService({credentials,content,queue,control,notifications:{disable:async(s,owner)=>{await control.markDisabled(owner,s);await tokens.revoke(owner);}}},{now:()=>now});
  const app=express();
  app.use((req,_res,next)=>{req.user={address};next();});
  app.use("/credentials",createConnectorCredentialRouter({credentials:credentials as any,oauth:{} as any,teardown,modes:{mode:async()=>"backend"},now:()=>now}));
  const server=app.listen(0,"127.0.0.1");
  await once(server,"listening");
  const port=(server.address() as any).port;
  try {
    expect((await fetch(`http://127.0.0.1:${port}/credentials/${source}`,{method:"DELETE"})).status).toBe(200);
    expect(revoked).toBe(1);
    expect(await control.readDisabled(address)).not.toBeNull();
    expect(await tokens.lookup(callback)).toBeNull();
    expect(await tokens.config(address)).toBeNull();
    expect(await tokens.lookup(otherCallback)).not.toBeNull();
    expect(await control.readDisabled(other)).toBeNull();
    expect(await content.list(source,address)).toEqual([]);
    expect(await queue.list(source,address)).toEqual([]);
    const ledger=await control.readLedger(source,address);
    expect(ledger.status).toBe("ok");
    if(ledger.status!=="ok")throw new Error("ledger missing");
    expect(ledger.ledger.recentIds).toEqual(["older","saved"]);
    expect(ledger.ledger.recentIdsAddedAt).toEqual({older:oldStamp,saved:new Date(initial).toISOString()});
    now+=day;
    await teardown.run(source,address); // Retry never restarts an ID clock.
    expect((f.data.get(purgeLedgerKey(source,address)) as any).recentIdsAddedAt.saved).toBe(new Date(initial).toISOString());
    now=initial+14*day-1;
    const before=await control.readLedger(source,address);
    expect(before.status==="ok"?before.ledger.recentIds:[]).toEqual(["saved"]);
    now+=1;
    await control.readLedger(source,address);
    expect((f.data.get(purgeLedgerKey(source,address)) as any).recentIds).toEqual([]);
    expect(f.data.has(disabledMarkerKey(address))).toBe(true);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
