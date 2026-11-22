import { expect, test } from "bun:test";
import { ConnectorQueue } from "../services/connector-queue.js";
import { ConnectorControlStore } from "../routes/connector-webhooks.js";

const source="fireflies", address="0x1111111111111111111111111111111111111111";
const initial=Date.parse("2026-11-12T12:00:00Z");
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
