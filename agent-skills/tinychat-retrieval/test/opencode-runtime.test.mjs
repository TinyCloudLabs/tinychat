import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, cp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('shipped installer loads the default initializer and registers zero-argument tools', { timeout: 90000 }, async t => {
  let version;
  try { version = (await exec('opencode', ['--version'], { timeout: 10000 })).stdout.trim(); }
  catch (error) {
    if (error.code === 'ENOENT') return t.skip('OpenCode executable unavailable; installed plugin startup was not exercised');
    throw error;
  }
  if (version !== '1.18.31') return t.skip(`Requires OpenCode 1.18.31; installed ${version}`);
  const root = await mkdtemp(join(tmpdir(), 'tinychat-opencode-install-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const config = join(root, 'config', 'opencode');
  const installed = join(home, '.agents', 'skills', 'tinychat-retrieval');
  let child;
  t.after(async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(project, { recursive: true, mode: 0o700 });
  await cp(fileURLToPath(new URL('../', import.meta.url)), installed, { recursive: true });
  await assert.rejects(access(join(installed, 'node_modules')), { code: 'ENOENT' });
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: root,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  };
  const installation = JSON.parse((await exec(process.execPath, [join(installed, 'scripts', 'install-opencode.mjs')], { env, cwd: project, timeout: 15000 })).stdout);
  assert.equal(installation.ok, true);
  assert.equal(installation.opencodeVersion, '1.18.31');
  assert.equal(installation.restartRequired, true);
  assert.equal(installation.pluginPath, join(config, 'plugins', 'tinychat-signin.js'));
  assert.match(await readFile(installation.pluginPath, 'utf8'), /export default/);
  await writeFile(join(config, 'opencode.json'), JSON.stringify({ model: 'openai/gpt-5.6-luna', share: 'disabled' }));
  child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', spawnError, base;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { spawnError = error; });
  const started = Date.now();
  while (!(base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0])) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `OpenCode server exited: ${output}`);
    assert.ok(Date.now() - started < 30000, `OpenCode server did not start: ${output}`);
    await delay(50);
  }
  async function request(path, body) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': project },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45000),
    });
    const result = await response.json();
    assert.ok(response.ok, `OpenCode API ${path} returned ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  const ids = await request('/experimental/tool/ids');
  assert.ok(ids.includes('tinychat_authorize'), 'installed default initializer must register the authorization tool');
  assert.ok(!ids.includes('tinychat_signin_status'), 'sign-in has no separate status tool');
  for (const id of ['tinychat_setup', 'tinychat_meetings', 'tinychat_handoff']) assert.ok(ids.includes(id), `Installed tool missing: ${id}`);
  const schemas = await request('/experimental/tool?provider=openai&model=gpt-5.6-luna');
  const meetings = schemas.find(value => value.id === 'tinychat_meetings');
  assert.ok(meetings?.parameters?.properties?.operation, 'actual runtime generates the operation argument schema');
  assert.ok(!meetings.parameters.properties.cursor && !meetings.parameters.properties.ref, 'opaque values are not model arguments');
  assert.ok(meetings.parameters.properties.action.enum.includes('latest'), 'installed schema exposes bounded latest selection');
  assert.ok(!meetings.parameters.properties.action.enum.includes('review'));
  assert.ok(meetings.parameters.properties.chunk);
  for(const removed of ['claim','spans','speaker','reviews','displayBytes','acknowledge'])assert.equal(meetings.parameters.properties[removed],undefined);
  const session = await request('/session', {});
  const text = 'Please find the meeting notes after I finish setting up TinyChat.';
  const sent = await request(`/session/${session.id}/message`, {
    noReply: true, model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
    parts: [{ type: 'text', text }],
  });
  assert.equal(sent.parts.find(part => part.type === 'text')?.text, text);
  const messages = await request(`/session/${session.id}/message`);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].info.role, 'user', 'no assistant/model turn should run');
  assert.equal(messages[0].parts.find(part => part.type === 'text')?.text, text);
  await assert.rejects(access(join(root, 'config', 'tinychat-retrieval', 'setup.json')), { code: 'ENOENT' });
});

test('installed default consumer returns complete cited evidence inside the real OpenCode runtime', { timeout: 120000 }, async t => {
  const executable = process.env.OPENCODE_TEST_EXECUTABLE || 'opencode';
  let version;
  try { version = (await exec(executable, ['--version'], { timeout: 10000 })).stdout.trim(); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Pinned OpenCode runtime unavailable'); throw error; }
  if (version !== '1.18.31') return t.skip(`Requires OpenCode 1.18.31; installed ${version}`);
  const root = await mkdtemp(join(tmpdir(), 'tinychat-opencode-default-consumer-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const config = join(root, 'config');
  const installed = join(home, '.agents/skills/tinychat-retrieval');
  const bin = join(root, 'bin');
  const callsPath = join(root, 'synthetic-subprocesses.jsonl');
  const runtimePath = join(root, 'synthetic-plugin-runtime.json');
  const bodyPath = join(root, 'synthetic-body.json');
  const owner = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';
  const space = `tinycloud:${owner.slice(4)}:applications`;
  const records = Array.from({ length: 300 }, (_, i) => ({ text: `Record ${String(i).padStart(3, '0')}: We reviewed the import checklist, confirmed the next small test, and kept the timing question open for the group. Next action. ${i % 3 === 0 ? '🙂 café 中文' : i % 3 === 1 ? 'é 🚀 naïve' : 'mañana 🧑‍💻'}. `, ...(i % 17 ? { speaker: `Fixture ${['A', 'B', 'C'][i % 3]}` } : {}), start_time: i * 2.5 }));
  records[1] = { text: 'Could you help with the import?', speaker: 'Fixture B', start_time: 2.5 };
  records[2] = { text: 'I can help with the import.', speaker: 'Fixture A', start_time: 5 };
  const transcriptBytes = records.reduce((sum, record) => sum + Buffer.byteLength(record.text), 0);
  assert.ok(transcriptBytes >= 45000 && transcriptBytes <= 50000);

  let child;
  t.after(async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited; clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(project, { recursive: true, mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  await mkdir(join(config, 'tinychat-retrieval'), { recursive: true, mode: 0o700 });
  await cp(fileURLToPath(new URL('../', import.meta.url)), installed, { recursive: true });
  await writeFile(bodyPath, JSON.stringify(records), { mode: 0o600 });
  await writeFile(join(config, 'tinychat-retrieval/setup.json'), JSON.stringify({ schemaVersion: 1, profile: 'default', config: { schemaVersion: 1, host: 'https://node.example.test', space: 'applications' } }), { mode: 0o600 });
  // The PATH node is a real Node process boundary with a synthetic argv audit.
  // No injected consumer runner or alternate retrieval implementation is used.
  await writeFile(join(bin, 'node'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({kind:'node',args})+'\\n', {mode:0o600});
const result = require('node:child_process').spawnSync(${JSON.stringify(process.execPath)}, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  await writeFile(join(bin, 'tinycloud'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const owner = ${JSON.stringify(owner)};
const profile = 'default', host = 'https://node.example.test';
if (args.includes('profile') || args.includes('context')) fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({kind:args.includes('profile')?'profile-list':'context'})+'\\n', {mode:0o600});
if (args.includes('--version')) process.stdout.write('0.10.0');
else if (args.includes('profile') && args.includes('list')) process.stdout.write(JSON.stringify({profiles:[{name:profile,host}]}));
else if (args.includes('context')) process.stdout.write(JSON.stringify({schemaVersion:1,profile,host,ownerDid:owner,spaceId:${JSON.stringify(space)},sessionDid:'did:key:synthetic-runtime',session:{state:'present',expiresAt:'2099-01-01T00:00:00Z'}}));
else if (args.includes('status')) process.stdout.write(JSON.stringify({authenticated:true,ownerDid:owner,profile,host}));
else if (args.includes('query')) {
  fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({kind:args.some(a=>a.includes('WHERE id = ?'))?'exact-read':'discovery-query'})+'\\n',{mode:0o600});
  const columns=['id','source','source_id','title','started_at','organizer_email','participants','summary_overview','summary_action_items','metadata','updated_at','sort_time'];
  const rows=[['runtime-meeting','fireflies','runtime-source-'+ 'x'.repeat(180),'Runtime synthetic meeting','2025-05-01T00:00:00Z',null,'[]',null,null,'{}',null,2460796.5]];
  if (!args.some(a=>a.includes('WHERE id = ?'))) rows.push(['older-meeting','fireflies','older-source','Older synthetic meeting','2025-04-01T00:00:00Z',null,'[]',null,null,'{}',null,2460766.5]);
  process.stdout.write(JSON.stringify({columns,rows,rowCount:rows.length}));
} else if (args.includes('get')) {
  fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({kind:'kv-get',bytes:fs.statSync(${JSON.stringify(bodyPath)}).size})+'\\n',{mode:0o600});
  fs.writeFileSync(args[args.indexOf('--output')+1],fs.readFileSync(${JSON.stringify(bodyPath)})); process.stdout.write('{}');
} else process.exit(2);
`, { mode: 0o700 });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: root,
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  const installation = JSON.parse((await exec(process.execPath, [join(installed, 'scripts/install-opencode.mjs')], { env, cwd: project, timeout: 15000 })).stdout);
  assert.equal(installation.ok, true);
  // Keep the generated loader and production default initializer; add only a
  // noReply chat controller so the actual tool can run without a model turn.
  const loader = await readFile(installation.pluginPath, 'utf8');
  const initializer = 'export default input => TinyChat(input, { schema: tool.schema });';
  assert.ok(loader.includes(initializer));
  await writeFile(installation.pluginPath, loader.replace(initializer, `export default async input => {
    const hooks = await TinyChat(input, { schema: tool.schema });
    await (await import('node:fs/promises')).writeFile(${JSON.stringify(runtimePath)}, JSON.stringify({execPath:process.execPath,node:process.versions.node,bun:process.versions.bun}),{mode:0o600});
    return {...hooks,'chat.message':async (message,output)=>{
      const part=output.parts.find(part=>part.type==='text' && part.text.startsWith('fixture-meetings '));
      if (!part) return hooks['chat.message']?.(message,output);
      const args=tool.schema.object(hooks.tool.tinychat_meetings.args).parse(JSON.parse(part.text.slice('fixture-meetings '.length)));
      part.text=await hooks.tool.tinychat_meetings.execute(args,{sessionID:message.sessionID});
    }};
  };`), { mode: 0o600 });
  await writeFile(join(config, 'opencode/opencode.json'), JSON.stringify({ model: 'openai/gpt-5.6-luna', share: 'disabled' }));
  child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', spawnError, base;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { spawnError = error; });
  const started = Date.now();
  while (!(base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0])) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `Synthetic OpenCode server exited: ${output}`);
    assert.ok(Date.now() - started < 30000, `Synthetic OpenCode server did not start: ${output}`);
    await delay(50);
  }
  async function request(path, body) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-opencode-directory': project }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) });
    const value = await response.json();
    assert.ok(response.ok, `Synthetic OpenCode API ${path}: ${JSON.stringify(value)}`);
    return value;
  }
  const session = await request('/session', {});
  const invoke = async args => {
    const result = await request(`/session/${session.id}/message`, { noReply: true, model: { providerID: 'openai', modelID: 'gpt-5.6-luna' }, parts: [{ type: 'text', text: 'fixture-meetings ' + JSON.stringify({ operation: 'runtime', ...args }) }] });
    return JSON.parse(result.parts.find(part => part.type === 'text').text);
  };
  const discovered = await invoke({ action: 'latest' });
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  t.diagnostic(`Synthetic plugin process.execPath=${runtime.execPath}; Node compatibility=${runtime.node}; Bun=${runtime.bun ?? 'none'}`);
  assert.equal(discovered.ok, true, 'Actual installed default initializer and Node runner acquire the selected body');
  assert.equal(discovered.selection.resolved, true);
  assert.ok(Array.isArray(discovered.spans), 'latest must return useful transcript evidence immediately');
  assert.equal(discovered.coverage.visibleComplete, false, 'acquisition never acknowledges unseen evidence');
  assert.deepEqual(await invoke({action:'latest'}),discovered,'Repeat preserves exact returned evidence');
  assert.equal(discovered.coverage.returnedComplete,true);
  assert.equal(discovered.nextAction,null,'No final acknowledgment or review call');
  const visible=records.map(()=>''),displays=1,displayedBytes=Buffer.byteLength(JSON.stringify(discovered));
  assert.ok(displayedBytes<=96*1024);
  for(const span of discovered.spans){
    assert.equal(span.start,visible[span.recordIndex].length);
    assert.equal(span.end-span.start,span.text.length);
    assert.equal(span.text,records[span.recordIndex].text.slice(span.start,span.end));
    assert.equal(span.speaker,records[span.recordIndex].speaker);
    assert.equal(span.startSecs,records[span.recordIndex].start_time);
    assert.equal(span.ref,`runtime/r${span.recordIndex}:${span.start}-${span.end}`);
    visible[span.recordIndex]+=span.text;
  }
  assert.deepEqual(visible,records.map(record=>record.text));
  assert.equal(discovered.spans[1].speaker,'Fixture B');
  assert.equal(discovered.spans[1].text,'Could you help with the import?');
  assert.equal(discovered.spans[2].speaker,'Fixture A');
  assert.equal(discovered.spans[2].text,'I can help with the import.');
  const calls=(await readFile(callsPath,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call=>call.kind==='profile-list').length,1);
  const helperPath = await realpath(join(installed, 'scripts/retrieve.mjs'));
  const retrieval = calls.filter(call => call.kind === 'node' && call.args[0] === helperPath);
  assert.equal(retrieval.filter(call => call.args[1] === 'diagnostics').length, 0);
  assert.equal(calls.filter(call => call.kind === 'exact-read').length, 1);
  const acquisitions = calls.filter(call => call.kind === 'kv-get');
  assert.equal(acquisitions.length, 1, 'Exactly one selected acquisition and no discarded diagnostics probe');
  assert.equal(acquisitions[0].bytes, Buffer.byteLength(JSON.stringify(records)));
  assert.ok((await request(`/session/${session.id}/message`)).every(message => message.info.role === 'user'), 'Only noReply user messages; no model call');
  t.diagnostic(`Installed OpenCode default runner: ${records.length} records / ${transcriptBytes} UTF-8 text bytes / ${displays} compact displays / ${displayedBytes} serialized display bytes / one KV acquisition; exact returned UTF-16 coverage and direct references; noReply does not establish client delivery`);
});
