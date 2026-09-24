import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const api = await import('../lib/opencode-plugin.mjs').catch(() => ({}));

async function fixture(t) {
  assert.equal(typeof api.createExperienceHooks, 'function', 'installed plugin must expose retrieval and local export');
  const root = await mkdtemp(join(tmpdir(), 'tinychat-experience-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const hooks = api.createExperienceHooks({
    setup: { async prepare(input) { calls.push({ prepare: input }); return { status: 'login-required', profile: 'synthetic' }; } },
    consumer: { async invoke(action, input, context) { calls.push({ action, input, context }); return { ok: true, status: 'synthetic', operation: input.operation }; } },
    client: { session: { async messages(input) { calls.push({ messages: input }); return { data: [{ info: { id: 'msg-fixture', sessionID: 'ses_fixture', role: 'assistant' }, parts: [{ id: 'part-fixture', sessionID: 'ses_fixture', type: 'text', text: 'RAW PRIVATE MESSAGE' }] }] }; } } },
    outputDirectory: root,
    versions: { candidate: 'synthetic', opencode: '1.18.31', cli: '0.10.0' },
  });
  return { root, calls, tool: hooks.tool };
}

test('normal tools continue compact evidence and pass session binding without model-supplied refs or cursors', async t => {
  const f = await fixture(t);
  const configPath = join(f.root, 'app.json');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, host: 'https://node.example.test', space: 'applications' }));
  const prepared = JSON.parse(await f.tool.tinychat_setup.execute({ configPath }, { sessionID: 'ses_fixture' }));
  assert.equal(prepared.status, 'login-required');
  assert.equal(f.calls[0].prepare.config.space, 'applications');
  const input = { action: 'next', operation: 'recap', chunk: 3 };
  const result = JSON.parse(await f.tool.tinychat_meetings.execute(input, { sessionID: 'ses_fixture' }));
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls[1], { action: 'next', input: { operation: 'recap', chunk: 3 }, context: { sessionID: 'ses_fixture' } });
  const rejected = JSON.parse(await f.tool.tinychat_meetings.execute({ action: 'read', operation: 'recap', cursor: 'PRIVATE_CURSOR' }, { sessionID: 'ses_fixture' }));
  assert.equal(rejected.ok, false);
  assert.equal(f.calls.length, 2);
  assert.ok(!JSON.stringify(rejected).includes('PRIVATE_CURSOR'));
});

test('continuation dispatches only a numbered chunk and documents direct answering',async t=>{
  const f=await fixture(t),input={operation:'recap',chunk:2};
  const result=JSON.parse(await f.tool.tinychat_meetings.execute({action:'next',...input},{sessionID:'ses_fixture'}));
  assert.equal(result.ok,true);
  assert.deepEqual(f.calls,[{action:'next',input,context:{sessionID:'ses_fixture'}}]);
  assert.match(f.tool.tinychat_meetings.description,/Answer directly/);
  assert.match(f.tool.tinychat_meetings.description,/No final acknowledgment, review or status call/);
});

test('session export uses only the current native session and writes a local diagnostic artifact', async t => {
  const f = await fixture(t);
  const result = JSON.parse(await f.tool.tinychat_handoff.execute({ goal: 'Summarize the last observed meeting.', nextAction: 'Check the named speaker in the final answer.' }, { sessionID: 'ses_fixture' }));
  assert.equal(result.ok, true);
  assert.ok(result.path.startsWith(f.root + '/'));
  assert.deepEqual(f.calls, [{ messages: { path: { id: 'ses_fixture' } } }]);
  const content = await readFile(result.path, 'utf8');
  assert.match(content, /ses_fixture/);
  assert.match(content, /Summarize the last observed meeting/);
  assert.match(content, /Check the named speaker/);
  assert.ok(!content.includes('RAW PRIVATE MESSAGE'));
  assert.match(content, /unavailable|not observed/i);
  assert.equal(JSON.parse(await f.tool.tinychat_handoff.execute({}, {})).ok, false);
});

test('normal meeting schema rejects removed review and receipt ceremony before consumer invocation',async t=>{
  const f=await fixture(t);
  for(const args of [{action:'review',claim:'Claim',spans:[{recordIndex:0}]},{action:'next',acknowledge:'receipt'},{action:'next',displayBytes:4000},{action:'next',reviews:[]}]){
    const result=JSON.parse(await f.tool.tinychat_meetings.execute({operation:'recap',...args},{sessionID:'ses_fixture'}));
    assert.equal(result.error.code,'INVALID_INPUT');
  }
  assert.equal(f.calls.length,0);
});

test('tool boundary preserves consumer failures and returns private export/setup errors', async t => {
  const f = await fixture(t);
  const hooks = api.createExperienceHooks({ setup: { async prepare() { throw Object.assign(new Error('PRIVATE_AUTH'), { code: 'OWNER_MISMATCH' }); } }, consumer: { async invoke() { return { ok: false, exitCode: 3, error: { code: 'AUTH_EXPIRED' }, progress: { pagesFetched: 2 } }; } }, client: {}, outputDirectory: f.root });
  const failed = JSON.parse(await hooks.tool.tinychat_meetings.execute({ action: 'read', operation: 'recap', page: 3 }, { sessionID: 'ses_fixture' }));
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.progress.pagesFetched, 2);
  const setup = JSON.parse(await hooks.tool.tinychat_setup.execute({}, { sessionID: 'ses_fixture' }));
  assert.equal(setup.error.code, 'OWNER_MISMATCH');
  assert.ok(!JSON.stringify(setup).includes('PRIVATE_AUTH'));
  assert.equal(JSON.parse(await hooks.tool.tinychat_handoff.execute({}, { sessionID: 'ses_fixture' })).ok, false);
});

test('practical client transform confirms only exact nontruncated noncompacted meeting tool outputs',async()=>{
  const calls=[];
  const hooks=api.createExperienceHooks({consumer:{async confirmDelivery(raw,context){calls.push({raw,context});return {ok:true,visibleComplete:true,deliveredChunks:1,totalChunks:1};}}});
  assert.equal(typeof hooks['experimental.chat.messages.transform'],'function');
  const value={ok:true,operation:'meeting',coverage:{chunk:1,returnedComplete:true,visibleComplete:false},spans:[{text:'Exact 🙂'}],nextAction:null};
  const raw=JSON.stringify(value);
  const part=(extra={})=>({type:'tool',tool:'tinychat_meetings',sessionID:'ses_test',state:{status:'completed',output:raw,metadata:{truncated:false},time:{start:1,end:2},...extra}});
  const valid=part(),truncated=part({metadata:{truncated:true}}),compacted=part({time:{compacted:3}}),running=part({status:'running'}),other={...part(),tool:'other'};
  await hooks['experimental.chat.messages.transform']({}, {messages:[{info:{sessionID:'ses_test',role:'assistant'},parts:[valid,truncated,compacted,running,other]}]});
  assert.deepEqual(calls,[{raw,context:{sessionID:'ses_test'}}]);
  assert.equal(JSON.parse(valid.state.output).coverage.visibleComplete,true);
  assert.equal(truncated.state.output,raw);
  assert.equal(compacted.state.output,raw);
});

test('practical export includes safe operation diagnostics without a status tool call',async t=>{
  const f=await fixture(t);
  const hooks=api.createExperienceHooks({consumer:{async diagnostics({sessionID}){return [{sessionID,stage:'retrieval',operation:'recap',status:'completed',visibleComplete:true,counts:{remoteBodyAcquisitions:1,remoteBodyBytes:70000},timings:{discoveryMs:11,retrievalMs:22},cliVersion:'0.10.0'}];}},client:{session:{async messages(){return {data:[]};}}},outputDirectory:f.root});
  const result=JSON.parse(await hooks.tool.tinychat_handoff.execute({}, {sessionID:'ses_fixture'}));
  assert.equal(result.ok,true);
  const content=await readFile(result.path,'utf8');
  assert.match(content,/remoteBodyAcquisitions=1/);
  assert.match(content,/retrieval: 22 ms/);
  assert.match(content,/CLI version: 0.10.0/);
});

test('practical delivery ignores errored assistant and non-assistant messages skipped by model conversion',async()=>{
  const calls=[];
  const hooks=api.createExperienceHooks({consumer:{async confirmDelivery(){calls.push(true);return {ok:true,visibleComplete:true};}}});
  const value={ok:true,spans:[{text:'saved'}],coverage:{chunk:1},operation:'op'};
  const part=()=>({type:'tool',tool:'tinychat_meetings',sessionID:'ses_test',state:{status:'completed',output:JSON.stringify(value),metadata:{truncated:false}}});
  await hooks['experimental.chat.messages.transform']({}, {messages:[
    {info:{sessionID:'ses_test',role:'assistant',error:{name:'APIError'}},parts:[part()]},
    {info:{sessionID:'ses_test',role:'user'},parts:[part()]},
  ]});
  assert.equal(calls.length,0);
});
