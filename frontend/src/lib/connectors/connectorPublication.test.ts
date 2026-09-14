import { describe, expect, test } from 'bun:test';
import * as store from './connectorStore';
import type { TinyCloudWeb } from '@tinycloud/web-sdk';

const meeting = {id:'discarded-random-id',source:'fireflies',sourceId:'provider-1',title:'Original',startedAt:null,durationSecs:null,organizerEmail:null,participants:[],summaryOverview:'Stored overview',summaryActionItems:null,keywords:null,meetingType:null,metadata:{}};
function fixture(overrides: Record<string,(command:any)=>unknown>={}) {
  const order:string[]=[]; const commands:any[]=[];
  const receipt=(value:unknown)=>({ok:true,data:{columns:['receipt'],rows:[[JSON.stringify(value)]],rowCount:1}});
  const native=async (_name:string,params:any[])=>{const c=JSON.parse(params[0]);order.push(c.operation);commands.push(c);if(overrides[c.operation])return overrides[c.operation](c);switch(c.operation){
    case 'capabilities': return receipt({contractVersion:3,writerFencing:true,snapshotImmutability:true,digestVerification:true});
    case 'activate': return receipt({contractVersion:3,status:'ready'});
    case 'reserve': return receipt({contractVersion:3,status:'reserved',operationId:c.operationId,generation:1,expectedHead:null,meetingRef:'stable-id',inserted:true,createdAt:'2026-09-14T00:00:00Z'});
    case 'stage': return receipt({contractVersion:3,status:'staged',revision:c.revision,snapshotKey:c.snapshotKey});
    case 'publish': return receipt({contractVersion:3,status:'published',operationId:c.operationId,revision:c.revision,meetingRef:'stable-id',inserted:true,createdAt:'2026-09-14T00:00:00Z'});
    default: throw Error('unexpected command '+c.operation);
  }};
  return {order,commands,receipt,tcw:{spaceId:'test-space',sql:{db:()=>({execute:native})}} as unknown as TinyCloudWeb};
}

describe('fenced connector publication',()=>{
 test('reserves before fresh fetch and confirms one coherent immutable snapshot',async()=>{
   const f=fixture();expect(typeof store.publishConnectorMeeting).toBe('function');
   const result=await store.publishConnectorMeeting(f.tcw,{source:'fireflies',sourceId:'provider-1'},async()=>{f.order.push('fetch');return {meeting,sentences:[{index:0,text:'first middle last',speaker_name:null,start_time:0,end_time:3}]};});
   expect(result.ok).toBe(true);expect(f.order).toEqual(['capabilities','activate','reserve','fetch','stage','publish']);
   const snapshot=JSON.parse(f.commands.find(c=>c.operation==='stage').snapshotRaw);expect(snapshot.meetingRef).toBe('stable-id');expect(snapshot.metadata.title).toBe('Original');expect(snapshot.body.raw).toContain('first middle last');expect(snapshot.body.basis).toBe('transcript');expect(snapshot.overview.provenance.freshness).toBe('unknown');
 });
 test('unsupported node stops before fresh fetch or any mutation',async()=>{
   const f=fixture({capabilities:()=>({ok:false,error:{code:'SQL_ERROR',message:'Statement not found'}})});let fetched=false;
   const result=await store.publishConnectorMeeting(f.tcw,{source:'fireflies',sourceId:'provider-1'},async()=>{fetched=true;return {meeting,sentences:[]};});
   expect(result).toMatchObject({ok:false,error:{code:'PUBLICATION_UPGRADE_REQUIRED'}});expect(fetched).toBe(false);expect(f.order).toEqual(['capabilities']);
 });
 test('a stale publication is not retried with cached data or acknowledged',async()=>{
   const f=fixture({publish:()=>({ok:true,data:{columns:['receipt'],rows:[[JSON.stringify({contractVersion:3,status:'superseded'})]],rowCount:1}})});let fetches=0;
   const result=await store.publishConnectorMeeting(f.tcw,{source:'fireflies',sourceId:'provider-1'},async()=>{fetches++;return {meeting,sentences:[]};});
   expect(result).toMatchObject({ok:false,error:{code:'PUBLICATION_SUPERSEDED'}});expect(fetches).toBe(1);expect(f.order.filter(x=>x==='reserve')).toHaveLength(1);
 });
 test('lost publish acknowledgment reconciles matching revision only',async()=>{
   let attempted:any;const f=fixture({publish:c=>{attempted=c;throw new Error('ack lost');},inspect:()=>({ok:true,data:{columns:['receipt'],rows:[[JSON.stringify({contractVersion:3,status:'published',operationId:attempted.operationId,revision:attempted.revision,meetingRef:'stable-id',createdAt:'2026-09-14T00:00:00Z',inserted:true})]],rowCount:1}})});
   const result=await store.publishConnectorMeeting(f.tcw,{source:'fireflies',sourceId:'provider-1'},async()=>({meeting,sentences:[]}));
   expect(result.ok).toBe(true);expect(f.order.at(-1)).toBe('inspect');expect(f.order.filter(x=>x==='publish')).toHaveLength(1);
 });
 test('a notes artifact remains notes and preserves explicitly cleared document-owned fields',async()=>{
   const f=fixture();const result=await store.publishConnectorMeeting(f.tcw,{source:'google-meet',sourceId:'doc-1'},async()=>({meeting:{...meeting,source:'google-meet',sourceId:'doc-1',summaryOverview:null,metadata:{notes_kind:'gemini',notes_association:'standalone',notes_owned_fields:['summary_overview','summary_action_items']}},sentences:[],body:{basis:'notes',schema:'text',raw:'Notes without a transcript',originalExtent:'known'}}));
   expect(result.ok).toBe(true);const snapshot=JSON.parse(f.commands.find(c=>c.operation==='stage').snapshotRaw);expect(snapshot.body.basis).toBe('notes');expect(snapshot.overview).toBe(null);expect(snapshot.metadata.metadata.notes_owned_fields).toContain('summary_overview');
 });
});

test('Fireflies sync refreshes known IDs once and reserves before provider detail fetch',async()=>{
  const { syncFireflies } = await import('./firefliesSync');const f=fixture();
  const result=await syncFireflies({tcw:f.tcw,store:{...store,ensureSchema:async()=>({ok:true,data:undefined}),listKnownSourceIds:async()=>({ok:true,data:['provider-1']}),countMeetings:async()=>({ok:true,data:1}),updateSyncState:async()=>({ok:true,data:undefined})},client:{delayMs:0,listNewTranscriptIds:async({knownIds}:any)=>{expect(knownIds).toEqual([]);return {ok:true,data:['provider-1','provider-1']};},getTranscript:async()=>{f.order.push('fetch');return {ok:true,data:{id:'provider-1',title:'Original',date:null,duration:1,sentences:[{index:0,text:'Fresh',speaker_name:null,start_time:0,end_time:1}],participants:[],summary:null}} as any;}}});
  expect(result.ok).toBe(true);expect(f.order.indexOf('reserve')).toBeLessThan(f.order.indexOf('fetch'));expect(f.order.filter(x=>x==='fetch')).toHaveLength(1);
});

test('transcriber reserves before fetching meeting and original transcript segments',async()=>{
 const {saveTranscriberMeeting}=await import('../transcriberSave');const f=fixture();
 const result=await saveTranscriberMeeting(f.tcw,'provider-1',async()=>{f.order.push('fetch');return {meeting:{id:'provider-1',meeting_url:'https://meet.google.com/abc-def',status:'completed',created_at:'2026-09-14T00:00:00Z'},transcript:{meeting_id:'provider-1',status:'completed',segments:[{text:'Raw original',speaker_name:'A',start:1,end:2}]}} as any;});
 expect(result.ok).toBe(true);expect(f.order.indexOf('reserve')).toBeLessThan(f.order.indexOf('fetch'));
});

test('Google Meet reserves before participant/transcript reads and preserves raw entries',async()=>{
 const {syncGoogleMeet}=await import('./gmeetSync');const f=fixture();
 const result=await syncGoogleMeet({tcw:f.tcw,store:{...store,getConnection:async()=>({ok:true,data:null}),countMeetings:async()=>({ok:true,data:0}),updateSyncState:async()=>({ok:true,data:undefined})},now:()=>Date.parse('2026-09-14T12:00:00Z'),client:{listConferenceRecords:async()=>({ok:true,data:[{name:'conferenceRecords/provider-1',startTime:'2026-09-14T10:00:00Z',endTime:'2026-09-14T10:10:00Z'}]}),listParticipants:async()=>{f.order.push('participants');return {ok:true,data:[]};},listTranscripts:async()=>({ok:true,data:[{name:'transcript-1',state:'ENDED'}]}),listTranscriptEntries:async()=>({ok:true,data:[{name:'entry-1',text:'Raw original',startTime:'2026-09-14T10:00:01Z',endTime:'2026-09-14T10:00:02Z'}]})} as any});
 expect(result.ok).toBe(true);expect(f.order.indexOf('reserve')).toBeGreaterThanOrEqual(0);expect(f.order.indexOf('reserve')).toBeLessThan(f.order.indexOf('participants'));expect(f.commands.some(c=>c.operation==='publish')).toBe(true);
});

test('publication preserves stronger date and null-lagging summary while allowing document-owned clears',async()=>{
 const prior={...meeting,title:'Prior title',startedAt:'2026-09-14T10:00:00Z',summaryOverview:'Prior overview',metadata:{datetime_source:'meet_conference_start'}};
 const f=fixture({reserve:c=>({ok:true,data:{columns:['receipt'],rows:[[JSON.stringify({contractVersion:3,status:'reserved',operationId:c.operationId,generation:2,expectedHead:'old',meetingRef:'stable-id',inserted:false,createdAt:'2026-09-01T00:00:00Z',previousMeeting:prior})]],rowCount:1}})});
 await store.publishConnectorMeeting(f.tcw,{source:'fireflies',sourceId:'provider-1'},async()=>({meeting:{...meeting,title:null,summaryOverview:null,startedAt:'2026-09-01T00:00:00Z',metadata:{datetime_source:'drive_created_time'}},sentences:[]}));
 const snapshot=JSON.parse(f.commands.find(c=>c.operation==='stage').snapshotRaw);expect(snapshot.metadata.title).toBe('Prior title');expect(snapshot.metadata.startedAt).toBe(prior.startedAt);expect(snapshot.overview.text).toBe('Prior overview');
});

test('original record count includes undecodable records omitted from display normalization',async()=>{
 const f=fixture();await store.publishConnectorMeeting(f.tcw,{source:'fireflies',sourceId:'provider-1'},async()=>({meeting,sentences:[{index:0,text:'surviving',speaker_name:null,start_time:0,end_time:1}],body:{basis:'transcript',schema:'json-records',raw:JSON.stringify([{text:'surviving'},null,{unsupported:'preserved'}]),originalExtent:'known'}}));
 const snapshot=JSON.parse(f.commands.find(c=>c.operation==='stage').snapshotRaw);expect(snapshot.body.original.recordCount).toBe(3);expect(JSON.parse(snapshot.body.raw)).toHaveLength(3);
});

test('transcriber capture loss remains an explicit body omission',async()=>{
 const {saveTranscriberMeeting}=await import('../transcriberSave');const f=fixture();
 await saveTranscriberMeeting(f.tcw,'provider-1',async()=>({meeting:{id:'provider-1',meeting_url:'https://meet.google.com/a',status:'completed',created_at:'2026-09-14T00:00:00Z'},transcript:{meeting_id:'provider-1',status:'completed',capture:{completion_reason:'evicted'},segments:[{text:'partial original',speaker_name:'A',start:0,end:1}]}} as any));
 const snapshot=JSON.parse(f.commands.find(c=>c.operation==='stage').snapshotRaw);expect(snapshot.body.original.captureComplete).toBe(false);expect(snapshot.body.omissions).toContainEqual({code:'upstream_capture_incomplete',detail:'evicted'});
});

test('verified Notes links never choose an ambiguous identity or collapse standalone documents',async()=>{
 const row=(id:string,sourceId:string,metadata:any)=>[id,sourceId,'same title','2026-09-14',null,null,JSON.stringify(metadata)];
 let rows=[row('notes','doc',{}),row('conf','conference',{docs_export_uris:['https://docs.google.com/document/d/doc/edit']})];
 const tcw={spaceId:'association-gate',sql:{db:()=>({execute:async()=>({ok:true,data:{}}),query:async()=>({ok:true,data:{rows}})})}} as unknown as TinyCloudWeb;
 const linked=await store.findGmeetNotesAssociation(tcw,'google-meet','doc',null,null);expect(linked).toMatchObject({ok:true,data:{id:'notes',sourceId:'doc',linkedMeetingSourceId:'conference'}});
 rows=[row('notes','doc',{}),row('legacy-conf','conference',{drive_file_id:'doc',notes_association:'attached'})];
 const legacy=await store.findGmeetNotesAssociation(tcw,'google-meet','doc',null,null);expect(legacy.ok && legacy.data?.linkedMeetingSourceId).toBeUndefined();
 rows=[row('a','doc',{}),row('b','doc',{})];expect(await store.findGmeetNotesAssociation(tcw,'google-meet','doc',null,null)).toMatchObject({ok:false,error:{code:'PUBLICATION_IDENTITY_COLLISION'}});
});

test('resolved SDK network errors reconcile an uncertain publish receipt without re-reserving',async()=>{
 let attempted:any;const f=fixture({publish:c=>{attempted=c;return {ok:false,error:{code:'NETWORK_ERROR',message:'lost response'}};},inspect:()=>({ok:true,data:{columns:['receipt'],rows:[[JSON.stringify({contractVersion:3,status:'published',operationId:attempted.operationId,revision:attempted.revision,meetingRef:'stable-id',createdAt:'2026-09-14',inserted:true})]],rowCount:1}})});
 const result=await store.publishConnectorMeeting(f.tcw,{source:'fireflies',sourceId:'provider-1'},async()=>({meeting,sentences:[]}));expect(result.ok).toBe(true);expect(f.order.filter(x=>x==='reserve')).toHaveLength(1);expect(f.order.at(-1)).toBe('inspect');
});

test('publication bounds the complete SQL transport frame including nested string escaping',async()=>{
 const f=fixture();const raw=JSON.stringify([{text:'"'.repeat(150000)}]);
 const result=await store.publishConnectorMeeting(f.tcw,{source:'fireflies',sourceId:'provider-1'},async()=>({meeting,sentences:[],body:{basis:'transcript',schema:'json-records',raw,originalExtent:'known'}}));
 expect(result).toMatchObject({ok:false,error:{code:'PUBLICATION_CAPACITY'}});expect(f.order).not.toContain('stage');
});

test('delete and purge activate a legacy-only catalog before mutation without requiring a publication',async()=>{
 const receipt=(value:unknown)=>({ok:true,data:{columns:['receipt'],rows:[[JSON.stringify(value)]],rowCount:1}});
 const deleted=fixture({delete:()=>receipt({contractVersion:3,status:'deleted',deletedCount:0})});
 expect(await store.removeGmeetNotes(deleted.tcw,'google-meet','missing-document')).toEqual({ok:true,data:'unchanged'});
 expect(deleted.order).toEqual(['capabilities','activate','delete']);
 const purged=fixture({purge:()=>receipt({contractVersion:3,status:'purged'})});
 expect((await store.purgeConnector(purged.tcw,'fireflies')).ok).toBe(true);expect(purged.order).toEqual(['capabilities','activate','purge']);
});
