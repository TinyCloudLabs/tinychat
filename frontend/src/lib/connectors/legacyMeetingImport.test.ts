import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { TinyCloudWeb } from '@tinycloud/web-sdk';
import * as migration from './connectorMigration';
import { publicationSha256, transcriptKvKey } from './connectorStore';

const api = migration as any;
function fixture(count = 1) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE connector_meeting(id TEXT PRIMARY KEY,source TEXT,source_id TEXT,title TEXT,started_at TEXT,duration_secs REAL,organizer_email TEXT,participants TEXT,summary_overview TEXT,summary_action_items TEXT,keywords TEXT,meeting_type TEXT,metadata TEXT,created_at TEXT,updated_at TEXT)`);
  const kv = new Map<string, string>();
  const commands: any[] = [];
  const operations = new Map<string, any>();
  let losePublish = false;
  let failStage = false;
  let wrappedAliasError = false;
  let aliasError: any = null;
  const kvErrors = new Map<string, any>();
  let onActivate = () => {};
  let onReserve = () => {};
  for (let i = 0; i < count; i++) {
    const id = `row-${String(i).padStart(4, '0')}`;
    db.run('INSERT INTO connector_meeting VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, 'fireflies', `source-${i}`, 'Old title', '2026-01-01T00:00:00Z', 17, null, JSON.stringify([{name:'Ana',email:null}]), 'Old overview', 'Follow up', '["key"]', 'review', '{"custom":"keep"}', 'created', 'updated']);
    kv.set(transcriptKvKey('fireflies', `source-${i}`), '[\n {"text":"Exact  café 🦋\\nquote", "speaker_name":"Ana"} \n]');
  }
  const query = async (sql: string, params: any[] = []) => {
    if(aliasError && sql.includes('connector_meeting_alias')) return {ok:false,error:aliasError};
    try { const stmt = db.query(sql); return {ok:true, data:{columns:stmt.columnNames, rows:stmt.values(...params)}}; }
    catch (error) { return (wrappedAliasError || String(error).includes('no such table: connector_meeting_alias')) && sql.includes('connector_meeting_alias')
      ? {ok:false,error:{code:'SQL_ERROR',message:'SQL query failed',meta:{status:400,responseSnippet:'SQLite error: no such table: connector_meeting_alias'}}}
      : {ok:false,error:{code:'SQL_ERROR',message:String(error)}}; }
  };
  const tcw = {sql:{db:()=>({query, execute:async (sql:string, params:string[]) => {
    expect(sql).toBe('tinycloud.meetingPublication.v3');
    const c = JSON.parse(params[0]); commands.push(c);
    const receipt = (data:object) => ({ok:true,data:{columns:['receipt'],rows:[[JSON.stringify({contractVersion:3,...data})]]}});
    if(c.operation==='capabilities') return receipt({writerFencing:true,snapshotImmutability:true,digestVerification:true});
    if(c.operation==='activate') {
      for(const [name,type] of [['head_revision','TEXT'],['head_snapshot_key','TEXT'],['publication_state','TEXT']]) {
        if(!db.query('PRAGMA table_info(connector_meeting)').all().some((r:any)=>r.name===name)) db.exec(`ALTER TABLE connector_meeting ADD COLUMN ${name} ${type}`);
      }
      onActivate();
      return receipt({status:'ready'});
    }
    const row = db.query('SELECT * FROM connector_meeting WHERE source=? AND source_id=?').get(c.source,c.sourceId) as any;
    if(c.operation==='inspect') {
      const op = operations.get(c.operationId);
      return receipt({status:op?.published?'published':'superseded',meetingRef:row.id,operationId:op?.published?c.operationId:null,revision:row.head_revision,snapshotKey:row.head_snapshot_key});
    }
    if(c.operation==='reserve') {
      const old = operations.get(c.operationId);
      const op = old ?? {generation:1,meetingRef:row.id,expectedHead:row.head_revision};
      operations.set(c.operationId,op);
      onReserve();
      return receipt({status:'reserved',operationId:c.operationId,...op});
    }
    if(c.operation==='stage') {
      if(failStage) { failStage=false; return {ok:false,error:{code:'NETWORK_ERROR',message:'stage interrupted'}}; }
      expect(await publicationSha256(c.snapshotRaw)).toBe(c.revision);
      kv.set(c.snapshotKey,c.snapshotRaw);
      return receipt({status:'staged',revision:c.revision,snapshotKey:c.snapshotKey});
    }
    if(c.operation==='publish') {
      operations.get(c.operationId).published=true;
      db.run("UPDATE connector_meeting SET head_revision=?,head_snapshot_key=?,publication_state='published' WHERE id=?",[c.revision,c.snapshotKey,row.id]);
      if(losePublish) {losePublish=false;return {ok:false,error:{code:'NETWORK_ERROR',message:'ack lost'}};}
      return receipt({status:'published',meetingRef:row.id,operationId:c.operationId,revision:c.revision,snapshotKey:c.snapshotKey});
    }
    throw Error(`Unexpected operation ${c.operation}`);
  }})},kv:{get:async(key:string,opts:any)=>{
    expect(opts.raw).toBe(true);
    if(kvErrors.has(key)) return {ok:false,error:kvErrors.get(key)};
    return kv.has(key)?{ok:true,data:{data:kv.get(key)}}:{ok:false,error:{code:'KV_NOT_FOUND',message:'key not found'}};
  },put:()=>{throw Error('Migration must use native stage, never overwrite old KV');}}} as unknown as TinyCloudWeb;
  return {db,kv,tcw,commands,kvErrors,losePublish:()=>{losePublish=true;},failStage:()=>{failStage=true;},wrappedAliasError:()=>{wrappedAliasError=true;},
    aliasError:(value:any)=>{aliasError=value;},onActivate:(fn:()=>void)=>{onActivate=fn;},onReserve:(fn:()=>void)=>{onReserve=fn;}};
}
async function prepare(f:ReturnType<typeof fixture>, options:object={}) {
  expect(api.prepareLegacyMeetingImport).toBeFunction();
  const result=await api.prepareLegacyMeetingImport(f.tcw,options);
  expect(result.ok).toBe(true);
  return result.data;
}

test('plans all 601 legacy records read-only and preserves exact raw bytes and metadata',async()=>{
  const f=fixture(601); const before=f.db.query('SELECT * FROM connector_meeting').values();
  const plan=await prepare(f);
  expect(plan.ready).toBe(true); expect(plan.exhausted).toBe(true); expect(plan.entries).toHaveLength(601);
  expect(f.commands).toHaveLength(0); expect(f.db.query('SELECT * FROM connector_meeting').values()).toEqual(before);
  const entry=plan.entries[500]; const snap=JSON.parse(entry.snapshotRaw);
  expect(snap.meetingRef).toBe('row-0500'); expect(snap.body.raw).toBe(f.kv.get(transcriptKvKey('fireflies','source-500')));
  expect(snap.body.original).toMatchObject({extent:'unknown',captureComplete:null,recordCount:1,digest:await publicationSha256(snap.body.raw)});
  expect(snap.legacyImport).toMatchObject({upstreamVerified:false,originalCatalog:{metadata:'{"custom":"keep"}',created_at:'created',updated_at:'updated'}});
  expect(snap.metadata.metadata.custom).toBe('keep'); expect(snap.overview.provenance).toMatchObject({provider:null,freshness:'unknown'});
});

test('incomplete, collision, missing, oversized and malformed plans cannot activate',async()=>{
  for(const kind of ['bounded','collision','missing','oversize','invalid','invalid-id']) {
    const f=fixture(kind==='bounded'?101:2);
    if(kind==='collision') f.db.run("UPDATE connector_meeting SET source_id='source-0'");
    if(kind==='missing') f.kv.delete(transcriptKvKey('fireflies','source-1'));
    if(kind==='oversize') f.kv.set(transcriptKvKey('fireflies','source-1'),'x'.repeat(1_048_577));
    if(kind==='invalid') f.kv.set(transcriptKvKey('fireflies','source-1'),'[{"not_text":1}]');
    if(kind==='invalid-id') f.db.run("UPDATE connector_meeting SET id='bad/id' WHERE id='row-0001'");
    const plan=await prepare(f,{maxPages:1}); expect(plan.ready).toBe(false); expect(plan.issues.length).toBeGreaterThan(0);
    expect((await api.runLegacyMeetingImport(f.tcw,plan)).ok).toBe(false); expect(f.commands).toHaveLength(0);
  }
});

test('imports notes with original IDs, aliases and unknown capture provenance',async()=>{
  const f=fixture(); f.db.run("UPDATE connector_meeting SET metadata='{"+'"notes_kind":"gemini","custom":"keep"'+"}'");
  f.db.exec("CREATE TABLE connector_meeting_alias(alias TEXT PRIMARY KEY,meeting_id TEXT); INSERT INTO connector_meeting_alias VALUES('old-ref','row-0000')");
  const plan=await prepare(f); const old=f.kv.get(transcriptKvKey('fireflies','source-0')); const receipts:any[]=[];
  const result=await api.runLegacyMeetingImport(f.tcw,plan,{onReceipt:async(r:any)=>{receipts.push(r);}});
  expect(result.ok).toBe(true); expect(receipts).toHaveLength(1); expect(receipts[0].status).toBe('published');
  const stage=f.commands.find(c=>c.operation==='stage'); const snap=JSON.parse(stage.snapshotRaw);
  expect(snap.meetingRef).toBe('row-0000'); expect(snap.aliases).toEqual(['old-ref']); expect(snap.body.basis).toBe('notes');
  expect(snap.body.raw).toBe(old); expect(f.kv.get(transcriptKvKey('fireflies','source-0'))).toBe(old);
  expect(f.commands.map(c=>c.operation)).toEqual(['capabilities','activate','inspect','reserve','stage','publish']);
});

test('resume after interruption and a lost publish acknowledgement never republishes completed heads',async()=>{
  const f=fixture(2); const plan=await prepare(f); f.failStage();
  expect((await api.runLegacyMeetingImport(f.tcw,plan)).ok).toBe(false);
  f.losePublish(); const next=await api.runLegacyMeetingImport(f.tcw,plan); expect(next.ok).toBe(true);
  const published=f.commands.filter(c=>c.operation==='publish').length;
  const resumed=await api.runLegacyMeetingImport(f.tcw,JSON.parse(JSON.stringify(plan)));
  expect(resumed.ok).toBe(true); expect(resumed.data.receipts.map((r:any)=>r.status)).toEqual(['already_published','already_published']);
  expect(f.commands.filter(c=>c.operation==='publish')).toHaveLength(published);
});

test('changed catalog, body, aliases or tampered plan fails before activation',async()=>{
  for(const change of ['row','body','alias','plan']) {
    const f=fixture(); const plan=await prepare(f);
    if(change==='row') f.db.run("UPDATE connector_meeting SET title='changed'");
    if(change==='body') f.kv.set(transcriptKvKey('fireflies','source-0'),'[]');
    if(change==='alias') f.db.exec("CREATE TABLE connector_meeting_alias(alias TEXT PRIMARY KEY,meeting_id TEXT); INSERT INTO connector_meeting_alias VALUES('new','row-0000')");
    if(change==='plan') plan.entries[0].snapshotRaw+=' ';
    expect((await api.runLegacyMeetingImport(f.tcw,plan)).ok).toBe(false); expect(f.commands).toHaveLength(0);
  }
});

test('a head published after planning is skipped without reserve or overwrite',async()=>{
  const f=fixture(); const plan=await prepare(f);
  f.db.exec("ALTER TABLE connector_meeting ADD COLUMN head_revision TEXT; ALTER TABLE connector_meeting ADD COLUMN publication_state TEXT; ALTER TABLE connector_meeting ADD COLUMN head_snapshot_key TEXT");
  f.db.run("UPDATE connector_meeting SET head_revision=?,publication_state='published'",['a'.repeat(64)]);
  const result=await api.runLegacyMeetingImport(f.tcw,plan);
  expect(result.ok).toBe(true); expect(result.data.receipts[0].status).toBe('skipped_published');
  expect(f.commands.filter(c=>['reserve','stage','publish'].includes(c.operation))).toHaveLength(0);
  expect(f.db.query('SELECT head_revision FROM connector_meeting').values()).toEqual([['a'.repeat(64)]]);
});

test('an orphan alias added after planning stops the whole run before activation',async()=>{
  const f=fixture(); const plan=await prepare(f);
  f.db.exec("CREATE TABLE connector_meeting_alias(alias TEXT PRIMARY KEY,meeting_id TEXT); INSERT INTO connector_meeting_alias VALUES('orphan','absent-row')");
  expect((await api.runLegacyMeetingImport(f.tcw,plan)).ok).toBe(false);
  expect(f.commands).toHaveLength(0);
});

test('malformed existing publication heads block planning rather than being overwritten',async()=>{
  const f=fixture(); f.db.exec('ALTER TABLE connector_meeting ADD COLUMN head_revision TEXT');
  f.db.run("UPDATE connector_meeting SET head_revision='not-a-digest'");
  const plan=await prepare(f); expect(plan.ready).toBe(false);
  expect(plan.issues).toContainEqual({meetingRef:'row-0000',code:'MIGRATION_PUBLICATION_STATE_INVALID'});
});

test('a failed item emits a content-free receipt identifying the failed native phase',async()=>{
  const f=fixture(); const plan=await prepare(f); f.failStage(); const receipts:any[]=[];
  const result=await api.runLegacyMeetingImport(f.tcw,plan,{onReceipt:(r:any)=>receipts.push(r)});
  expect(result.ok).toBe(false); expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({meetingRef:'row-0000',status:'failed',code:'MIGRATION_STAGE_FAILED'});
  expect(JSON.stringify(receipts)).not.toContain('café');
});

test('recognizes pinned SDK missing-alias-table metadata without requiring an activation',async()=>{
  const f=fixture(); f.wrappedAliasError();
  const plan=await prepare(f); expect(plan.ready).toBe(true); expect(f.commands).toHaveLength(0);
});

test('preserves fractional REAL duration for the corrected native publication protocol',async()=>{
  const f=fixture(); f.db.run('UPDATE connector_meeting SET duration_secs=1.25');
  const plan=await prepare(f); expect(plan.ready).toBe(true);
  const snapshot=JSON.parse(plan.entries[0].snapshotRaw);
  expect(snapshot.metadata.metadata.connector_fields.durationSecs).toBe(1.25);
  expect(snapshot.legacyImport.originalCatalog.duration_secs).toBe(1.25);
  expect((await api.runLegacyMeetingImport(f.tcw,plan)).ok).toBe(true);
});

test('activation-time metadata and identity changes cannot be overwritten by the saved plan',async()=>{
  for(const changed of ['title','identity','head']) {
    const f=fixture(); const plan=await prepare(f);
    f.onActivate(()=>f.db.run(changed==='title'?"UPDATE connector_meeting SET title='newer title'":changed==='identity'?"UPDATE connector_meeting SET source_id='newer-identity'":"UPDATE connector_meeting SET head_revision='bad-digest'"));
    expect((await api.runLegacyMeetingImport(f.tcw,plan)).ok).toBe(false);
    expect(f.commands.filter(c=>['reserve','stage','publish'].includes(c.operation))).toHaveLength(0);
  }
});

test('activation-time or reservation-time old KV changes stop before stage',async()=>{
  for(const phase of ['activate','reserve']) {
    const f=fixture(); const plan=await prepare(f);
    const mutate=()=>f.kv.set(transcriptKvKey('fireflies','source-0'),'[{"text":"newer original"}]');
    if(phase==='activate') f.onActivate(mutate); else f.onReserve(mutate);
    const result=await api.runLegacyMeetingImport(f.tcw,plan);
    expect(result.ok).toBe(false); expect(result.error.code).toBe('MIGRATION_BODY_CHANGED');
    expect(f.commands.filter(c=>['stage','publish'].includes(c.operation))).toHaveLength(0);
  }
});

test('authorization, space and ambiguous key errors are never classified as missing originals',async()=>{
  for(const error of [
    {code:'KV_NOT_FOUND',message:'Cannot decrypt key'},
    {code:'KV_NOT_FOUND',message:'Space not found; key unavailable'},
    {code:'KV_NOT_FOUND',message:'key not found',meta:{status:401}},
    {code:'AUTH_UNAUTHORIZED',message:'key not found'},
  ]) {
    const f=fixture(); f.kvErrors.set(transcriptKvKey('fireflies','source-0'),error);
    const plan=await prepare(f); expect(plan.ready).toBe(false);
    expect(plan.issues).toContainEqual({meetingRef:'row-0000',code:'MIGRATION_BODY_READ_FAILED'});
  }
});

test('only pinned SQL400 missing-table response makes aliases absent',async()=>{
  for(const error of [
    {code:'AUTH_UNAUTHORIZED',message:'no such table: connector_meeting_alias',meta:{status:401}},
    {code:'SQL_ERROR',message:'no such table: connector_meeting_alias'},
    {code:'SQL_ERROR',message:'no such table: connector_meeting_alias',meta:{status:500}},
    {code:'SQL_ERROR',message:'no such table: connector_meeting_alias',meta:{status:400,responseSnippet:'SQLite error: no such column: meeting_id'}},
  ]) {
    const f=fixture(); f.aliasError(error);
    const result=await api.prepareLegacyMeetingImport(f.tcw);
    expect(result.ok).toBe(false); expect(result.error.code).toBe('MIGRATION_ALIAS_READ_FAILED'); expect(f.commands).toHaveLength(0);
  }
});
