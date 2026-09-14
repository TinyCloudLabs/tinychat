import { expect, test } from 'bun:test';
import { readTranscript } from './meetingExplorer';
import { mergeMeetings } from './meetingsView';
import { publicationSha256, snapshotKvKey } from './connectorStore';
import type { TinyCloudWeb } from '@tinycloud/web-sdk';

test('Library overlap chooses the published connector revision metadata',()=>{
 const result=mergeMeetings({source:'fireflies',server:[{sourceId:'x',title:'Archive stale',ts:'2026-09-01',hasTranscript:true,hasSummary:true}],local:[{source:'fireflies',sourceId:'x',title:'Published',startedAt:'2026-09-14',revision:'digest',readiness:'published'}]});
 expect(result[0].title).toBe('Published');expect(result[0].ts).toBe('2026-09-14');
});

test('Library reads exact published snapshot and rejects digest/key overwrites',async()=>{
 const raw=JSON.stringify([{index:0,text:'Complete original',speaker_name:'A',start_time:0,end_time:1}]);
 const snapshot=JSON.stringify({contractVersion:3,meetingRef:'row',source:'fireflies',sourceId:'x',metadata:{},body:{basis:'transcript',schema:'json-records',raw,original:{digest:await publicationSha256(raw),byteLength:new TextEncoder().encode(raw).length}}});
 const revision=await publicationSha256(snapshot);let corrupted=false;const keys:string[]=[];
 const tcw={sql:{db:()=>({query:async(sql:string)=>({ok:true,data:{rows:sql.includes('connector_publication_snapshot')?[[revision]]:[['row',revision,snapshotKvKey('fireflies','x',revision),'published']]}})})},kv:{get:async(key:string,options:any)=>{keys.push(key);expect(options.raw).toBe(true);return {ok:true,data:{data:corrupted?'corrupt':snapshot}};}}} as unknown as TinyCloudWeb;
 expect(await readTranscript(tcw,'fireflies','x',revision)).toMatchObject({status:'ok',revision,sentences:[{text:'Complete original'}]});
 corrupted=true;expect(await readTranscript(tcw,'fireflies','x',revision)).toEqual({status:'failed'});expect(keys[0]).toContain('/snapshot/');
});

test('Library catalog reports storage failure instead of claiming an empty archive',async()=>{
 const {listMeetingsResult}=await import('./meetingExplorer');
 const tcw={sql:{db:()=>({query:async()=>({ok:false,error:{code:'NETWORK_ERROR',message:'offline'}})})}} as unknown as TinyCloudWeb;
 expect(await listMeetingsResult(tcw)).toEqual({status:'unavailable'});
});


test('Library rejects a staged-only or invalidated revision and rechecks after body fetch',async()=>{
 const raw=JSON.stringify([{text:'prior body'}]);const snapshot=JSON.stringify({contractVersion:3,meetingRef:'row',source:'fireflies',sourceId:'x',metadata:{},body:{basis:'transcript',schema:'json-records',raw,original:{digest:await publicationSha256(raw),byteLength:new TextEncoder().encode(raw).length}}});const revision=await publicationSha256(snapshot);
 let published=false;let reads=0;let invalidateDuringRead=false;
 const tcw={sql:{db:()=>({query:async(sql:string)=>({ok:true,data:{rows:sql.includes('connector_publication_snapshot')?(published?[[revision]]:[]):[['row',revision,'key','published']]}})})},kv:{get:async()=>{reads++;if(invalidateDuringRead)published=false;return {ok:true,data:{data:snapshot}};}}} as unknown as TinyCloudWeb;
 expect((await readTranscript(tcw,'fireflies','x',revision)).status).toBe('absent');expect(reads).toBe(0);
 published=true;invalidateDuringRead=true;expect((await readTranscript(tcw,'fireflies','x',revision)).status).toBe('absent');expect(reads).toBe(1);
});
