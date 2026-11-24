import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createTrustBotReadsInternalRouter, createTrustBotReadsRouter, TRUSTBOT_READS_INTERNAL_PREFIX } from '../routes/trustbot-reads';
import { ReadGrantRefused, type TrustBotReadGrants } from '../trustbot-reads/grants';
import { signedCallHeader } from '../bots-signed-call';
import type { BotsConfig } from '../routes/bots';
const address=`0x${'ab'.repeat(20)}`,owner=`did:pkh:eip155:1:${address}`,secret='s'.repeat(48);
const account='a'.repeat(64), chat=`${account}:123`;

test('signed Telegram route gates area and denial; owner settings use independent grant metadata', async()=>{
  const main=new Database(':memory:'),state=new Database(':memory:');
  main.exec("CREATE TABLE layout_complete(id INTEGER,source TEXT);INSERT INTO layout_complete VALUES(1,'fresh');CREATE TABLE messages(account_id TEXT,source_chat_id TEXT,source_message_id TEXT,sender_id TEXT,sent_at INTEGER,deleted_at INTEGER,expires_at INTEGER,body_kv_key TEXT);CREATE TABLE participants(account_id TEXT,source_chat_id TEXT,source_participant_id TEXT,display_name TEXT,address TEXT,observed_at INTEGER)");
  state.exec('CREATE TABLE inbox_shards(sequence INTEGER);INSERT INTO inbox_shards VALUES(1);CREATE TABLE accounts(id TEXT,connector TEXT);CREATE TABLE chats(account_id TEXT,source_chat_id TEXT,title TEXT,kind TEXT,updated_at INTEGER)');
  state.run("INSERT INTO accounts VALUES(?,'telegram')",[account]);state.run("INSERT INTO chats VALUES(?,'123','Synthetic','private',1)",[account]);
  const body=`xyz.tinycloud.inbox/media/${account}/bodies/${'1'.repeat(64)}`;
  main.run("INSERT INTO messages VALUES(?,'123','10','42',1234,NULL,NULL,?)",[account,body]);
  let enabled=false;const denied=new Set<string>();const queries:string[]=[];const fetched:string[]=[];const disabled:string[]=[];
  const primaryStatus={grantCid:'primary',expiresAt:111,areas:{meetings:'on',feed_chats:'off'}};
  const primary={serviceDid:'did:pkh:eip155:1:'+address,status:async()=>primaryStatus,readStatus:async()=>({...primaryStatus,deniedChatIds:new Set(denied)}),deniedChatIds:async()=>new Set(denied),disable:async()=>{throw new Error('must not disable primary');}} as unknown as TrustBotReadGrants;
  const telegram={status:async()=>({grantCid:enabled?'telegram':null,expiresAt:enabled?222:null,areas:{telegram:enabled?'on':'off'}}),disable:async(_address:string,area:string)=>{disabled.push(area);enabled=false;},access:async()=>{
    if(!enabled)throw new ReadGrantRefused('off');
    return{sql:{db:(database:string)=>({query:async(sql:string,params:Array<string|number|null>)=>{queries.push(database);return{ok:true,data:{rows:(database.endsWith('/state')?state:main).query(sql).values(...params)}};}})},kv:{get:async(key:string)=>{fetched.push(key);return{ok:true,data:{data:JSON.stringify({text:'synthetic body',content:null})}};}}};
  }} as unknown as TrustBotReadGrants;
  const config={serviceUrl:'http://bots.test',serviceSecret:'s',postTimeoutMs:1000,accountAllowed:(who:string)=>who===address,fetchImpl:async()=>new Response('{}')} as BotsConfig;
  const app=express();
  app.use(TRUSTBOT_READS_INTERNAL_PREFIX,createTrustBotReadsInternalRouter({grants:primary,telegramGrants:telegram,config,callSecret:secret}));
  app.use('/api/bots/main/reads',createTrustBotReadsRouter({grants:primary,telegramGrants:telegram,config,auth:(req,_res,next)=>{req.user={address} as typeof req.user;next();}}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post=async(tool:string,args:unknown)=>{const path=`${TRUSTBOT_READS_INTERNAL_PREFIX}/${tool}`,body=JSON.stringify({args});return(await fetch(base+path,{method:'POST',headers:{authorization:signedCallHeader(secret,{direction:'to-backend',environment:'private',owner,bot:'main',method:'POST',path,body})},body})).json();};
  try{
    expect(await post('read_telegram_chat',{chat})).toEqual({ok:false,error:'off'});expect(queries).toEqual([]);
    enabled=true;denied.add(chat);
    expect(await post('read_telegram_chat',{chat})).toEqual({ok:false,error:'denied'});expect(queries).toEqual([]);expect(fetched).toEqual([]);
    const listed=await post('list_telegram_chats',{});expect(JSON.parse(listed.text).chats).toEqual([]);
    const ownerList=await(await fetch(base+'/api/bots/main/reads/telegram/chats')).json();expect(ownerList.chats).toEqual([{chat,title:'Synthetic'}]);
    denied.clear();const read=await post('read_telegram_chat',{chat});expect(JSON.parse(read.text).messages[0]).toMatchObject({sender:'Telegram user 42',time:1234,text:'synthetic body'});expect(fetched).toEqual([body]);
    expect(await post('read_status',{})).toEqual({enabledReadAreas:['meetings','telegram'],deniedChatIds:[]});
    const settings=await(await fetch(base+'/api/bots/main/reads')).json();expect(settings).toMatchObject({grantCid:'primary',expiresAt:111,telegramGrantCid:'telegram',telegramExpiresAt:222});
    const off=await(await fetch(base+'/api/bots/main/reads/telegram',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})})).json();expect(off.areas).toMatchObject({meetings:'on',telegram:'off'});expect(disabled).toEqual(['telegram']);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));main.close();state.close();}
});
