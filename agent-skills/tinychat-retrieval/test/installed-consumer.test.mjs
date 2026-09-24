import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const owner = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';
const context = { schemaVersion: 1, status: 'ready', profile: 'tinychat-agent', host: 'https://node.example.test', owner, space: `tinycloud:${owner.slice(4)}:applications`, sessionDid: 'did:key:fixture' };
context.retrievalArgs = ['--profile', context.profile, '--host', context.host, '--space', context.space, '--owner', context.owner];
const records = [{ id: 'proposal', text: 'Proposal 🙂 '.repeat(12000), speaker: 'A', timestamp: '00:01' }, { id: 'question', text: 'Is that agreed?', speaker: 'B', timestamp: '00:20' }, { id: 'decision', text: 'Still unresolved.', speaker: 'A', timestamp: '00:30' }];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tinychat-shipped-consumer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pack = join(directory, 'installed pack $ literal');
  await mkdir(join(pack, 'scripts'), { recursive: true });
  await mkdir(join(pack, 'lib'));
  for (const name of ['pack.json', 'lib/retrieval.mjs', 'lib/consumer.mjs', 'lib/evidence.mjs', 'lib/setup.mjs', 'lib/login.mjs', 'lib/approval.mjs', 'scripts/retrieve.mjs', 'scripts/consume.mjs']) {
    await copyFile(join(source, name), join(pack, name));
  }
  const body = join(directory, 'fixture-body.json');
  const mode = join(directory, 'mode');
  const calls = join(directory, 'calls.jsonl');
  await writeFile(body, JSON.stringify(records));
  await writeFile(mode, 'ready');
  const stub = join(directory, 'tc fixture');
  await writeFile(stub, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
const owner = ${JSON.stringify(owner)};
const id = 'intended-meeting';
const sourceId = 'long-source-' + 'x'.repeat(180);
if (args.includes('--version')) process.stdout.write('0.10.0');
else if (args.includes('profile') && args.includes('list')) process.stdout.write(JSON.stringify({profiles:[{name:'tinychat-agent',host:'https://node.example.test'}]}));
else if (args.includes('context')) process.stdout.write(JSON.stringify({schemaVersion:1,profile:'tinychat-agent',host:'https://node.example.test',ownerDid:owner,spaceId:${JSON.stringify(context.space)},sessionDid:'did:key:fixture',session:{state:'present',expiresAt:'2099-01-01T00:00:00Z'}}));
else if (args.includes('status')) process.stdout.write(JSON.stringify({authenticated:true,ownerDid:owner,profile:'tinychat-agent',host:'https://node.example.test'}));
else if (args.includes('query')) {
 const exact = args.some(a => a.includes('WHERE id = ?'));
 fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({kind:exact?'exact':'discovery'})+'\\n');
 const columns=['id','source','source_id','title','started_at','organizer_email','participants','summary_overview','summary_action_items','metadata','updated_at','sort_time'];
 const row=[id,'fireflies',sourceId,'Synthetic intended meeting',null,null,'[]',null,null,'{}',null,null];
 const params=JSON.parse(args[args.indexOf('--params')+1]);
 let rows=[row];
 if (mode==='catalog-pages' && !exact && args.some(a=>a.includes('LIMIT ?'))) rows=params.length>1?[['later-meeting',...row.slice(1)]]:[row,['later-meeting',...row.slice(1)]];
 if (mode==='many-dated' && !exact) rows=[row,['older-meeting',...row.slice(1)]];
 if (mode==='many-dated') { rows[0][4]='2025-04-01T00:00:00Z'; rows[0][11]=2460766.5; if(rows[1]) {rows[1][4]='2025-03-01T00:00:00Z'; rows[1][11]=2460735.5;} }
 if (mode==='changed-catalog' && !exact) rows=[['other-meeting',...row.slice(1)]];
 process.stdout.write(JSON.stringify({columns,rows,rowCount:rows.length}));
} else if (args.includes('get')) {
 fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({kind:'kv-get',bytes:mode==='fail'?0:fs.statSync(${JSON.stringify(body)}).size})+'\\n');
 if (mode==='fail') {process.stderr.write(JSON.stringify({error:{code:'AUTH_EXPIRED',message:'SECRET_FIXTURE_DETAIL'}})); process.exit(3);}
 fs.writeFileSync(args[args.indexOf('--output')+1],fs.readFileSync(${JSON.stringify(body)})); process.stdout.write('{}');
} else process.exit(2);
`, { mode: 0o700 });
  const installed = await import(pathToFileURL(join(pack, 'lib/consumer.mjs')));
  let current = structuredClone(context);
  current.retrievalArgs.push('--tc', stub);
  const runs = [];
  const run = async args => {
    runs.push(structuredClone(args));
    try { const r = await exec(process.execPath, [join(pack, 'scripts/retrieve.mjs'), ...args]); return { ...r, exitCode: 0 }; }
    catch (error) { return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code }; }
  };
  const options = { setup: { context: async () => structuredClone(current) }, root: join(directory, 'private'), packRoot: pack, projectDirectory: join(directory, 'project'), run };
  await mkdir(options.projectDirectory);
  const invoke = (command, input, sessionID = 'session-fixture') => installed.createConsumer(options).invoke(command, input, { sessionID });
  return { directory, pack, body, mode, calls, runs, invoke, current, options, records, installed, stub };
}

async function latest(f, operation = 'lean') {
  await writeFile(f.mode, 'many-dated');
  return f.invoke('latest', { operation });
}
async function complete(f, operation = 'lean', first) {
  let result = first ?? await latest(f, operation);
  const outputs = [],consumer=f.installed.createConsumer(f.options);
  for(;;){
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=96*1024);
    outputs.push(result);
    assert.ok(outputs.length<60);
    const delivery=await consumer.confirmDelivery(JSON.stringify(result),{sessionID:'session-fixture'});
    assert.equal(delivery.ok,true,JSON.stringify(delivery));
    if(!result.nextAction)break;
    const {action,...input}=result.nextAction;
    result=await f.invoke(action,input);
  }
  result=await f.invoke('status',{operation});
  assert.equal(result.visibleComplete,true);
  return {result,outputs};
}
test('latest immediately emits compact original evidence and one continuation covers the whole retained body', async t => {
  const f = await fixture(t);
  const first = await latest(f);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.spans?.length, 'latest must deliver useful evidence, not another orchestration step');
  assert.equal(first.spans[0].citation, undefined);
  assert.equal(first.spans[0].source, undefined);
  assert.equal(first.record.id, 'intended-meeting');
  const { result, outputs } = await complete(f, 'lean', first);
  const visible = f.records.map(() => '');
  for (const output of outputs) {
    assert.equal(output.displayReceipt, undefined);
    for (const span of output.spans) {
      assert.equal(span.start, visible[span.recordIndex].length);
      assert.equal(span.end - span.start, span.text.length);
      assert.ok(!/[\uD800-\uDBFF]$/.test(span.text));
      visible[span.recordIndex] += span.text;
    }
  }
  assert.deepEqual(visible, f.records.map(r => r.text));
  assert.equal(outputs.at(-1).coverage.returnedComplete, true);
  assert.equal(result.counts.remoteBodyAcquisitions, 1);
  assert.equal(f.runs.filter(args => args[0] === 'read').length, 1);
  assert.equal(f.runs.filter(args => args[0] === 'diagnostics').length, 0);
  assert.equal((await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse).filter(v => v.kind === 'kv-get').length, 1);
});
test('latest and next retries replay exact evidence without certifying delivery or refetching',async t=>{
  const f=await fixture(t),first=await latest(f);
  assert.deepEqual(await f.invoke('latest',{operation:'lean'}),first);
  assert.equal((await f.invoke('status',{operation:'lean'})).visibleComplete,false);
  const {action,...input}=first.nextAction;
  const second=await f.invoke(action,input);
  assert.equal(second.ok,true,JSON.stringify(second));
  assert.deepEqual(await f.invoke(action,input),second);
  assert.equal((await f.invoke('next',{operation:'lean',acknowledge:'forged'})).error.code,'INVALID_INPUT');
  assert.equal(f.runs.filter(a=>a[0]==='read').length,1);
});

test('direct references retain known, unknown and multiple speakers without claim rewriting',async t=>{
  const f=await fixture(t);
  await writeFile(f.body,JSON.stringify([{text:'I propose trying this.',speaker:'A',start_time:7},{text:'Is that agreed?',speaker:'B'},{text:'Unknown answer.'}]));
  const first=await latest(f);
  assert.equal(first.nextAction,null);
  assert.equal(first.spans[0].ref,'lean/r0:0-22');
  assert.equal(first.spans[0].speaker,'A');
  assert.equal(first.spans[1].speaker,'B');
  assert.equal(first.spans[2].speaker,undefined);
  assert.match(first.citationGuide,/Unknown speakers cannot support named attribution/);
  assert.equal(first.coverage.visibleComplete,false);
});

test('historical continuation survives remote revocation and body changes; explicit restart reacquires selected meeting', async t => {
  const f = await fixture(t), first = await latest(f);
  await writeFile(f.body, JSON.stringify([{text:'Changed body'}]));
  await writeFile(f.mode,'fail');
  const next = await f.invoke('next', {operation:'lean',chunk:2});
  assert.equal(next.ok,true,JSON.stringify(next));
  assert.equal(next.access.currentAuthorityVerified,false);
  const restart = await f.invoke('restart',{operation:'lean',newOperation:'fresh'});
  assert.equal(restart.error.code,'AUTH_EXPIRED');
  await writeFile(f.mode,'changed-catalog');
  const fresh = await f.invoke('read',{operation:'fresh',retry:true});
  assert.equal(fresh.ok,true,JSON.stringify(fresh));
  assert.equal(fresh.record.id,'intended-meeting');
  assert.equal(fresh.spans[0].text,'Changed body');
  assert.notEqual(fresh.provenance.bodySha256,first.provenance.bodySha256);
});
test('identity, context, operation and conversation switches reject before reading saved evidence', async t => {
  const f = await fixture(t), first = await latest(f);
  const input = {operation:'lean',chunk:2};
  assert.equal((await f.invoke('next',input,'other')).error.code,'SESSION_MISMATCH');
  assert.equal((await f.invoke('latest',{operation:'lean',source:'google-meet'})).error.code,'OPERATION_MISMATCH');
  f.current.sessionDid='did:key:changed';
  assert.equal((await f.invoke('next',input)).error.code,'CONTEXT_MISMATCH');
  f.current.sessionDid=context.sessionDid;
  f.current.owner='did:pkh:eip155:1:0x2222222222222222222222222222222222222222';
  assert.equal((await f.invoke('next',input)).error.code,'CONTEXT_MISMATCH');
  assert.equal(f.runs.filter(args=>args[0]==='read').length,1);
});
test('saved body corruption stops local continuation without a silent remote fallback', async t => {
  const f=await fixture(t),first=await latest(f);
  const directory=join(f.options.root,'lean');
  const state=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
  await writeFile(join(directory,state.acquired.acquisitionDirectory,'body'),'[]');
  const next=await f.invoke('next',{operation:'lean',chunk:2});
  assert.equal(next.error.code,'ACQUISITION_INVALID');
  assert.equal(f.runs.filter(a=>a[0]==='read').length,1);
});
test('KV denial while SQL succeeds remains classified and retry acquires once in a fresh attempt directory', async t => {
  const f=await fixture(t);
  await writeFile(f.mode,'many-dated');
  const original=f.options.run;
  f.options.run=async args=>{if(args[0]==='read')await writeFile(f.mode,'fail');return original(args);};
  const fail=await f.invoke('latest',{operation:'denial'});
  assert.equal(fail.error.code,'AUTH_EXPIRED');
  assert.ok(!JSON.stringify(fail).includes('SECRET_FIXTURE_DETAIL'));
  f.options.run=original;await writeFile(f.mode,'many-dated');
  const pass=await f.invoke('latest',{operation:'denial',retry:true});
  assert.equal(pass.ok,true,JSON.stringify(pass));
  assert.equal(f.runs.filter(a=>a[0]==='latest').length,1);
});
test('empty and undated latest never substitute a body', async t=>{
  const f=await fixture(t);
  const result=await f.invoke('latest',{operation:'undated'});
  assert.equal(result.ok,true);
  assert.equal(result.selection.resolved,false);
  assert.equal(result.nextAction,null);
  assert.equal(f.runs.filter(a=>a[0]==='read').length,0);
});
test('general discovery still pages and selected read begins the same compact continuation',async t=>{
  const f=await fixture(t);await writeFile(f.mode,'catalog-pages');
  const first=await f.invoke('discover',{operation:'browse',limit:1});
  const second=await f.invoke('discover',{operation:'browse',page:2});
  assert.equal(first.moreDiscovery,true);
  assert.equal(second.meetings[0].meeting,2);
  const read=await f.invoke('read',{operation:'browse',meeting:1});
  assert.equal(read.ok,true,JSON.stringify(read));
  assert.ok(read.spans.length);
});
test('operation locks, output collisions and project-local storage fail before remote fetch',async t=>{
  const f=await fixture(t);
  await mkdir(join(f.options.root,'collision'),{recursive:true,mode:0o700});
  await writeFile(join(f.options.root,'collision','setup-attempt-1.response.json'),'existing',{mode:0o600});
  assert.equal((await f.invoke('latest',{operation:'collision'})).error.code,'FILE_COLLISION');
  await mkdir(join(f.options.root,'busy'),{mode:0o700});
  await writeFile(join(f.options.root,'busy','operation.lock'),'held',{mode:0o600});
  assert.equal((await f.invoke('latest',{operation:'busy'})).error.code,'OPERATION_BUSY');
  const unsafe=f.installed.createConsumer({...f.options,root:join(f.options.projectDirectory,'state')});
  assert.equal((await unsafe.invoke('latest',{operation:'unsafe'},{sessionID:'fixture'})).error.code,'PRIVATE_DIRECTORY_REQUIRED');
  assert.equal(f.runs.length,0);
});
test('continuation rejects invalid chunks and obsolete review fields without remote calls',async t=>{
  const f=await fixture(t);await latest(f);const before=f.runs.length;
  for(const chunk of [undefined,0,-1,1.5,'2'])assert.equal((await f.invoke('next',{operation:'lean',chunk})).error.code,'INVALID_INPUT');
  assert.equal((await f.invoke('next',{operation:'lean',chunk:999})).error.code,'TRAVERSAL_COMPLETE');
  for(const extra of [{reviews:[]},{displayBytes:4000},{acknowledge:'x'},{spans:[{recordIndex:0}]}])assert.equal((await f.invoke('next',{operation:'lean',chunk:2,...extra})).error.code,'INVALID_INPUT');
  assert.equal(f.runs.length,before);
});

test('default runner still launches literal node and classifies NODE_UNAVAILABLE',async t=>{
  const f=await fixture(t);
  const driver=join(f.directory,'missing-node.mjs');
  await writeFile(driver,`import {createConsumer} from ${JSON.stringify(pathToFileURL(join(f.pack,'lib/consumer.mjs')).href)};
const setup={context:async()=>(${JSON.stringify(f.current)})};
console.log(JSON.stringify(await createConsumer({setup,root:${JSON.stringify(f.options.root)},packRoot:${JSON.stringify(f.pack)},projectRoot:${JSON.stringify(f.options.projectDirectory)}}).invoke('latest',{operation:'missing-node'},{sessionID:'s'})));`);
  const result=await exec(process.execPath,[driver],{env:{...process.env,PATH:'/nonexistent'}});
  assert.equal(JSON.parse(result.stdout).error.code,'NODE_UNAVAILABLE');
});
test('portable installed CLI returns complete cited evidence with no completion ceremony',async t=>{
  const f=await fixture(t);
  const home=join(f.directory,'home'),bin=join(f.directory,'bin');
  await mkdir(join(home,'.config','tinychat-retrieval'),{recursive:true,mode:0o700});await mkdir(bin);
  await copyFile(f.stub,join(bin,'tc'));
  await writeFile(join(home,'.config','tinychat-retrieval','setup.json'),JSON.stringify({schemaVersion:1,profile:context.profile,owner,config:{schemaVersion:1,host:context.host,space:'applications'}}));
  await writeFile(f.body,JSON.stringify([{text:'Try this.',speaker:'A'}]));await writeFile(f.mode,'many-dated');
  const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'.config'),XDG_STATE_HOME:join(home,'.local/state'),PATH:bin+':'+process.env.PATH};
  const script=join(f.pack,'scripts/consume.mjs');
  const first=JSON.parse((await exec('node',[script,'latest','--operation','portable','--session','cli-session','--root',f.options.root],{env,cwd:f.options.projectDirectory})).stdout);
  assert.equal(first.spans[0].text,'Try this.');
  assert.equal(first.nextAction,null);
  assert.equal(first.coverage.returnedComplete,true);
  assert.equal(first.coverage.visibleComplete,false,'stdout alone is not proof of model-input delivery');
  assert.equal(first.spans[0].ref,'portable/r0:0-9');
});

test('corrupt saved layout cannot omit evidence and still certify full delivery',async t=>{
  const f=await fixture(t),first=await latest(f);
  const path=join(f.options.root,'lean','state.json');const state=JSON.parse(await readFile(path,'utf8'));
  state.layout=state.layout.slice(0,1);
  await writeFile(path,JSON.stringify(state),{mode:0o600});
  const next=await f.invoke('next',{operation:'lean',chunk:2});
  assert.equal(next.error.code,'STATE_INCOMPLETE');
});
test('chunk delivery is bound to issued payloads and complete ordered coverage',async t=>{
  const f=await fixture(t),first=await latest(f),consumer=f.installed.createConsumer(f.options);
  const second=await f.invoke('next',{operation:'lean',chunk:2});
  assert.equal((await consumer.confirmDelivery(JSON.stringify(second),{sessionID:'session-fixture'})).error.code,'DISPLAY_RECEIPT_INVALID');
  assert.equal((await consumer.confirmDelivery(JSON.stringify(first),{sessionID:'session-fixture'})).visibleComplete,false);
  assert.equal((await consumer.confirmDelivery(JSON.stringify(first),{sessionID:'session-fixture'})).visibleComplete,false);
  const confirmed=await consumer.confirmDelivery(JSON.stringify(second),{sessionID:'session-fixture'});
  assert.equal(confirmed.visibleComplete,true);
});

test('narrow answers retain honest partial coverage and exact speaker evidence',async t=>{
  const f=await fixture(t),first=await latest(f),consumer=f.installed.createConsumer(f.options);
  const delivery=await consumer.confirmDelivery(JSON.stringify(first),{sessionID:'session-fixture'});
  assert.equal(delivery.visibleComplete,false);
  assert.equal(first.spans[0].speaker,'A');
  assert.equal(first.spans[0].ref,`lean/r0:0-${first.spans[0].end}`);
  assert.equal(first.coverage.corpusComplete,false);assert.equal(first.provenance.captureComplete,null);
  assert.deepEqual(first.provenance.excludedCatalogs,['user-kv-only','backend-only']);
  assert.equal(f.runs.length,2);
});

test('status also rejects corrupt retained evidence and never claims complete coverage from unread data',async t=>{
  const f=await fixture(t);await latest(f);
  const directory=join(f.options.root,'lean');const state=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
  await writeFile(join(directory,state.acquired.acquisitionDirectory,'body'),'[]');
  const result=await f.invoke('status',{operation:'lean'});
  assert.equal(result.error.code,'ACQUISITION_INVALID');
});

test('practical recap returns six directly citable groups in one complete payload without receipt or review', async t => {
  const f = await fixture(t);
  const records = Array.from({length:300}, (_, i) => ({text:`Record ${String(i).padStart(3,'0')}: We reviewed the import checklist, confirmed the next small test, and kept the timing question open for the group. Next action. 🙂 café 中文. `,speaker:`Speaker ${i%3}`,start_time:i*2.5}));
  await writeFile(f.body, JSON.stringify(records));
  const first = await latest(f);
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal(first.nextAction,null,'ordinary ~47KB meeting needs one delivery, no final acknowledgment');
  assert.equal(first.coverage.returnedComplete,true);
  assert.equal(first.coverage.visibleComplete,false,'emission alone cannot establish post-client delivery');
  assert.equal(first.displayReceipt,undefined);
  assert.equal(first.spans.length,records.length);
  assert.ok(Buffer.byteLength(JSON.stringify(first))<=96*1024);
  assert.deepEqual(first.spans.map(s=>s.text),records.map(r=>r.text));
  const groups=[3,3,3,6,3,8].map((n,group)=>Array.from({length:n},(_,i)=>first.spans[group+i*6]));
  for(const group of groups)for(const span of group){assert.equal(span.ref,`lean/r${span.recordIndex}:0-${records[span.recordIndex].text.length}`);assert.equal(span.speaker,records[span.recordIndex].speaker);assert.equal(span.startSecs,records[span.recordIndex].start_time);}
  assert.equal((await f.invoke('review',{operation:'lean',claim:'Unnecessary',spans:[{recordIndex:0}]})).error.code,'INVALID_INPUT');
  const consumer=f.installed.createConsumer(f.options);
  const confirmed=await consumer.confirmDelivery(JSON.stringify(first),{sessionID:'session-fixture'});
  assert.equal(confirmed.visibleComplete,true,JSON.stringify(confirmed));
  assert.equal((await f.invoke('status',{operation:'lean'})).visibleComplete,true);
  assert.equal(f.runs.filter(args=>args[0]==='read').length,1);
});

test('practical delivery requires the exact issued payload and session, not a saved body or partial output', async t=>{
  const f=await fixture(t),first=await latest(f),consumer=f.installed.createConsumer(f.options);
  assert.equal(typeof consumer.confirmDelivery,'function');
  assert.equal((await consumer.confirmDelivery(JSON.stringify(first).slice(0,-1),{sessionID:'session-fixture'})).ok,false);
  const modified=structuredClone(first);modified.spans[0].text='omitted';
  assert.equal((await consumer.confirmDelivery(JSON.stringify(modified),{sessionID:'session-fixture'})).ok,false);
  assert.equal((await consumer.confirmDelivery(JSON.stringify(first),{sessionID:'different'})).error?.code,'SESSION_MISMATCH');
  assert.equal((await f.invoke('status',{operation:'lean'})).visibleComplete,false);
});

test('practical long Unicode record uses explicit repeatable chunks with exact boundaries and honest partial coverage',async t=>{
  const f=await fixture(t),text='Long 🙂 中文 é 🧑‍💻 record. '.repeat(12000);
  await writeFile(f.body,JSON.stringify([{text,speaker:'A',start_time:3}]));
  let value=await latest(f),visible='',count=0;
  const consumer=f.installed.createConsumer(f.options);
  assert.ok(value.nextAction);
  assert.equal(value.coverage.returnedComplete,false);
  while(value.spans){
    assert.ok(++count<20);
    assert.ok(Buffer.byteLength(JSON.stringify(value))<=96*1024);
    assert.deepEqual(await f.invoke(value.coverage.chunk===1?'latest':'next',{operation:'lean',...(value.coverage.chunk===1?{}:{chunk:value.coverage.chunk})}),value);
    for(const span of value.spans){assert.equal(span.start,visible.length);assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(span.text));visible+=span.text;}
    const delivery=await consumer.confirmDelivery(JSON.stringify(value),{sessionID:'session-fixture'});
    assert.equal(delivery.visibleComplete,value.nextAction===null);
    if(!value.nextAction)break;
    const {action,...input}=value.nextAction;value=await f.invoke(action,input);
  }
  assert.equal(visible,text);
  assert.ok(count>1);
  assert.equal((await f.invoke('status',{operation:'lean'})).visibleComplete,true);
  assert.equal(f.runs.filter(args=>args[0]==='read').length,1);
});

test('practical diagnostics use only session-bound saved delivery counts and acquisition timings',async t=>{
  const f=await fixture(t),first=await latest(f),consumer=f.installed.createConsumer(f.options);
  assert.equal(typeof consumer.diagnostics,'function');
  assert.deepEqual(await consumer.diagnostics({sessionID:'another-session'}),[]);
  const before=await consumer.diagnostics({sessionID:'session-fixture'});
  assert.equal(before[0].visibleComplete,false);
  await consumer.confirmDelivery(JSON.stringify(first),{sessionID:'session-fixture'});
  const after=await consumer.diagnostics({sessionID:'session-fixture'});
  assert.equal(after[0].visibleComplete,false);
  assert.equal(after[0].counts.remoteBodyAcquisitions,1);
  assert.equal(after[0].cliVersion,'0.10.0');
  assert.ok(Number.isFinite(after[0].timings.retrievalMs));
  assert.equal(after[0].context,undefined);
  assert.equal(after[0].spans,undefined);
  assert.equal(f.runs.length,2);
});

test('practical delivery refuses missing session binding and corrupted layout before confirming',async t=>{
  const f=await fixture(t),first=await latest(f),consumer=f.installed.createConsumer(f.options);
  const path=join(f.options.root,'lean','state.json'),original=JSON.parse(await readFile(path,'utf8'));
  const missing=structuredClone(original);delete missing.sessionHash;await writeFile(path,JSON.stringify(missing),{mode:0o600});
  assert.equal((await consumer.confirmDelivery(JSON.stringify(first),{sessionID:'different'})).error?.code,'SESSION_MISMATCH');
  const corrupt=structuredClone(original);corrupt.layout=corrupt.layout.slice(0,1);await writeFile(path,JSON.stringify(corrupt),{mode:0o600});
  assert.equal((await consumer.confirmDelivery(JSON.stringify(first),{sessionID:'session-fixture'})).error.code,'STATE_INCOMPLETE');
});

test('practical diagnostics preserve failed acquisitions and survive unrelated incomplete operation directories',async t=>{
  const f=await fixture(t);await latest(f);
  await f.invoke('status',{operation:'orphan'});
  await mkdir(join(f.options.root,'corrupt'),{mode:0o700});
  await writeFile(join(f.options.root,'corrupt','state.json'),'not json',{mode:0o600});
  const consumer=f.installed.createConsumer(f.options);
  const healthy=await consumer.diagnostics({sessionID:'session-fixture'});
  assert.equal(healthy.length,1);
  assert.equal(healthy[0].operation,'lean');
  const original=f.options.run;
  f.options.run=async args=>{if(args[0]==='read')await writeFile(f.mode,'fail');return original(args);};
  const failed=await f.invoke('latest',{operation:'denied'});
  assert.equal(failed.error.code,'AUTH_EXPIRED');
  const diagnostic=(await consumer.diagnostics({sessionID:'session-fixture'})).find(v=>v.operation==='denied');
  assert.equal(diagnostic.status,'failed');
  assert.equal(diagnostic.error.code,'AUTH_EXPIRED');
  assert.equal(diagnostic.visibleComplete,false);
});
