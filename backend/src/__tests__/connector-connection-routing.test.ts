import { expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import { IngestModeService, INGEST_COHORT_KEY } from "../services/ingest-mode.js";
import { InMemoryCredentialRowStore, CredentialStore } from "../services/credential-store.js";
import { ConnectorQueue } from "../services/connector-queue.js";
import { ContentStore, InMemoryContentBlobStore } from "../services/content-store.js";
import { ConnectorFetchWorker } from "../services/fetch-worker.js";
import { ConnectorControlStore, ConnectorWebhookLimiters, createConnectorWebhookCompanionRouter } from "../routes/connector-webhooks.js";
import { createConnectorCredentialRouter } from "../routes/connector-credentials.js";

const source="fireflies", owner="0x1111111111111111111111111111111111111111", other="0x2222222222222222222222222222222222222222";
const now=Date.parse("2026-11-12T12:00:00Z");
function fixture() {
  const data=new Map<string,unknown>([[INGEST_COHORT_KEY,{addresses:[owner]}]]);
  const node={kv:{
    async get(key:string){return data.has(key)?{ok:true,data:{data:data.get(key)}}:null;},
    async put(key:string,value:unknown){data.set(key,value);return {ok:true};},
    async delete(key:string){data.delete(key);return {ok:true};},
  }};
  const rows=new InMemoryCredentialRowStore();
  const credentials=new CredentialStore(rows,{now:()=>now,master:()=>"Zk9pQ2xUb0FzRHZFcldxTnBZeEhtQjNnU2o1dDBjMD0="});
  const modes=new IngestModeService(node as any,{enabled:()=>true,hasOAuthCredential:async(s,a)=>{
    const row=await rows.read(s,a);return row?.kind==="oauth"&&!row.revokedAt;
  }});
  const queue=new ConnectorQueue(node as any,{now:()=>now,flushWindowMs:0});
  const content=new ContentStore(new InMemoryContentBlobStore(),{now:()=>now,master:()=>"R29vZE1hc3RlckZvckNvbnRlbnRFbnZlbG9wZXNBQTA9"});
  const connect=()=>credentials.store({source,address:owner,secret:{kind:"oauth",accessToken:"fixture-access"}});
  return {data,node,rows,credentials,modes,queue,content,connect};
}

test("effective mode follows fresh per-source OAuth presence, independently of cohort cache", async () => {
  const f=fixture();
  expect(await f.modes.eligible(owner)).toBe(true);
  expect(await f.modes.mode(owner,source)).toBe("browser");
  await f.credentials.store({source,address:owner,secret:{kind:"api_key",apiKey:"fixture-key"}});
  expect(await f.modes.mode(owner,source)).toBe("browser");
  await f.connect();
  expect(await f.modes.mode(owner,source)).toBe("backend");
  expect(await f.modes.mode(owner,"another-source")).toBe("browser");
  expect(await f.modes.mode(other,source)).toBe("browser");
  await f.rows.remove(source,owner);
  expect(await f.modes.mode(owner,source)).toBe("browser");
});

test("a cohort API-key user sees browser pending IDs and can start OAuth without an existing server credential", async () => {
  const f=fixture();
  await f.queue.enqueue(source,owner,{meetingId:"waiting",kind:"summary"});
  const tokens={config:async()=>({source,token:"a".repeat(43),createdAt:new Date(now).toISOString()})};
  const app=express();
  app.use(express.json());
  app.use((req,_res,next)=>{req.user={address:owner};next();});
  app.use("/webhooks",createConnectorWebhookCompanionRouter({tokens:tokens as any,queue:f.queue,control:new ConnectorControlStore(f.node as any,()=>now),limiters:new ConnectorWebhookLimiters(),modes:f.modes}));
  app.use("/credentials",createConnectorCredentialRouter({credentials:f.credentials,modes:f.modes,oauth:{authorizeUrl:()=>"https://provider.invalid/authorize"} as any}));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const browser=await (await fetch(`${base}/webhooks/pending`)).json();
    expect(browser.pending.map((row:any)=>row.meetingId)).toEqual(["waiting"]);
    expect((await fetch(`${base}/credentials/${source}/oauth/start`,{method:"POST"})).status).toBe(200);
    await f.connect();
    const backend=await (await fetch(`${base}/webhooks/pending`)).json();
    expect(backend.surfaceBlocked).toBe("backend_ingest");
    expect(backend.pending).toEqual([]);
    expect((await f.queue.list(source,owner)).map(row=>row.meetingId)).toEqual(["waiting"]);
    await f.rows.remove(source,owner);
    const again=await (await fetch(`${base}/webhooks/pending`)).json();
    expect(again.pending.map((row:any)=>row.meetingId)).toEqual(["waiting"]);
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test("credential addition/removal transfers queue ownership without dropping or duplicating deliveries", async () => {
  const f=fixture();let fetches=0;
  const worker=new ConnectorFetchWorker({queue:f.queue,modes:f.modes,credentials:f.credentials,content:f.content,fetcher:{fetchMeeting:async request=>{
    fetches++;return {ok:true,content:{sourceId:request.meetingId,ts:new Date(now).toISOString(),payload:{text:"meeting"}}};
  }}},{now:()=>now,spacingMs:0});
  await f.queue.enqueue(source,owner,{meetingId:"first",kind:"summary"});
  await worker.runOnce();
  expect(fetches).toBe(0);
  expect(await f.queue.list(source,owner)).toHaveLength(1);
  await f.connect();
  await worker.runOnce();
  expect(fetches).toBe(1);
  expect(await f.content.list(source,owner)).toHaveLength(1);
  expect(await f.queue.list(source,owner)).toEqual([]);
  await f.rows.remove(source,owner);
  await f.queue.enqueue(source,owner,{meetingId:"browser-owned",kind:"summary"});
  await worker.runOnce();
  expect(fetches).toBe(1);
  expect(await f.queue.list(source,owner)).toHaveLength(1);
  await f.queue.acknowledge(source,owner,[{meetingId:"browser-owned",kind:"summary"}]);
  await f.connect();
  await worker.runOnce();
  expect(fetches).toBe(1);
  expect(await f.queue.list(source,owner)).toEqual([]);
  expect(await f.content.list(source,owner)).toHaveLength(1);
});

test("removing OAuth during an in-flight fetch leaves the ID for browser consumption and stores no copy", async () => {
  const f=fixture();await f.connect();
  const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const worker=new ConnectorFetchWorker({queue:f.queue,modes:f.modes,credentials:f.credentials,content:f.content,fetcher:{fetchMeeting:async request=>{
    started.resolve();await release.promise;return {ok:true,content:{sourceId:request.meetingId,ts:new Date(now).toISOString(),payload:{text:"meeting"}}};
  }}},{now:()=>now,spacingMs:0});
  await f.queue.enqueue(source,owner,{meetingId:"handoff",kind:"summary"});
  const pass=worker.runOnce();await started.promise;
  await f.rows.remove(source,owner);release.resolve();await pass;
  expect(await f.content.list(source,owner)).toEqual([]);
  expect((await f.queue.list(source,owner)).map(row=>row.meetingId)).toEqual(["handoff"]);
});

test("revoked OAuth falls back to browser and unreadable credential presence never guesses a consumer", async () => {
  const f=fixture();await f.connect();
  const row=await f.rows.read(source,owner);
  await f.rows.write({...row!,revokedAt:new Date(now).toISOString()});
  expect(await f.modes.mode(owner,source)).toBe("browser");
  const unavailable=new IngestModeService(f.node as any,{enabled:()=>true,hasOAuthCredential:async()=>{throw new Error("credential metadata unavailable");}});
  await expect(unavailable.mode(owner,source)).rejects.toThrow("credential metadata unavailable");
});
