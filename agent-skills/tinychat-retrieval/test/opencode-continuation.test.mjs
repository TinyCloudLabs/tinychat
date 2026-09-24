import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, rm, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const moduleURL = new URL('../lib/opencode-continuation.mjs', import.meta.url);
async function fixture(t) {
  await assert.doesNotReject(access(moduleURL), 'the installed adapter must implement exact-session continuation');
  const { resumeActivation } = await import(moduleURL);
  const root = await mkdtemp(join(tmpdir(), 'tinychat-continuation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { HOME: root, XDG_STATE_HOME: join(root, 'state'), OPENCODE_PID: '12345' };
  const directory = join(root, 'project');
  const state = join(env.XDG_STATE_HOME, 'tinychat-retrieval/opencode-activation');
  await mkdir(directory); await mkdir(state, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const descriptor = { schemaVersion: 1, hostPID: 12345, nonce: 'a'.repeat(64), marker: 'TINYCHAT_ACTIVATION:' + 'a'.repeat(64), sessionID: 'ses_original', messageID: 'msg_install', partID: 'prt_install', userMessageID: 'msg_user', directory, agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5.6-luna' }, createdAt: now - 100, expiresAt: now + 119900, integrationVersion: '0.1.1-onboarding.15' };
  const message = { info: { id: descriptor.messageID, sessionID: descriptor.sessionID, role: 'assistant', parentID: descriptor.userMessageID, agent: descriptor.agent, ...descriptor.model }, parts: [{ id: descriptor.partID, messageID: descriptor.messageID, sessionID: descriptor.sessionID, type: 'tool', tool: 'bash', state: { status: 'error', error: 'Tool execution aborted', metadata: { output: descriptor.marker + '\n', interrupted: true }, input: { command: 'node install-opencode.mjs --activate' } } }] };
  const calls = [];
  const client = { tool: { ids: async () => ({ data: ['tinychat_setup', 'tinychat_authorize'] }) }, session: {
    get: async () => ({ data: { id: descriptor.sessionID, directory } }),
    message: async args => { calls.push(['message', args]); return { data: message }; },
    messages: async args => { calls.push(['messages', args]); return { data: [message] }; },
    status: async () => ({ data: {} }),
    promptAsync: async args => { calls.push(['prompt', args]); return {}; },
  } };
  const path = join(state, '12345.json');
  const save = value => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await save(descriptor);
  const run = () => resumeActivation({ client, directory, env, version: descriptor.integrationVersion, now: () => now });
  return { client, descriptor, message, calls, run, save, path, state };
}

test('loaded adapter resumes the bound chat once with the original model and agent', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.run(), f.run()]);
  assert.equal(results.filter(value => value.status === 'resumed').length, 1);
  const prompts = f.calls.filter(([kind]) => kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0][1].path, { id: f.descriptor.sessionID });
  assert.deepEqual(prompts[0][1].body.model, f.descriptor.model);
  assert.equal(prompts[0][1].body.agent, 'build');
  assert.match(prompts[0][1].body.parts[0].text, /TinyChat installation completed/);
  assert.match(prompts[0][1].body.parts[0].text, /original request/);
  assert.ok(f.calls.filter(([kind]) => kind === 'message').every(([, args]) => args.path.id === 'ses_original'));
  assert.equal(f.calls.find(([kind]) => kind === 'messages')[1].query.limit, 1);
  assert.ok((await readdir(f.state)).some(name => name.endsWith('.result.json')));
  assert.equal((await f.run()).status, 'absent');
});

for (const [label, change] of [
  ['expired request', f => f.save({ ...f.descriptor, expiresAt: 1 })],
  ['different host', f => f.save({ ...f.descriptor, hostPID: 54321 })],
  ['different directory', f => f.save({ ...f.descriptor, directory: '/elsewhere' })],
  ['wrong native tool', f => { f.message.parts[0].id = 'prt_other'; }],
  ['missing installer marker', f => { f.message.parts[0].state.metadata.output = 'unrelated command'; }],
  ['nonprivate activation directory', f => chmod(f.state, 0o755)],
  ['changed model', f => { f.message.info.modelID = 'different'; }],
  ['new message after installation', f => { f.client.session.messages = async () => ({ data: [{ info: { id: 'msg_new' } }] }); }],
  ['busy conversation', f => { f.client.session.status = async () => ({ data: { ses_original: { type: 'busy' } } }); }],
  ['capture tools unavailable', f => { f.client.tool.ids = async () => ({ data: [] }); }],
]) test(`does not resume a ${label}`, async t => {
  const f = await fixture(t); await change(f);
  assert.equal((await f.run()).status, 'failed');
  assert.equal(f.calls.filter(([kind]) => kind === 'prompt').length, 0);
});

test('an ambiguous continuation response is never retried automatically', async t => {
  const f = await fixture(t);
  f.client.session.promptAsync = async args => { f.calls.push(['prompt', args]); throw new Error('synthetic network failure'); };
  assert.equal((await f.run()).status, 'failed');
  assert.equal((await f.run()).status, 'absent');
  assert.equal(f.calls.filter(([kind]) => kind === 'prompt').length, 1);
  const result = JSON.parse(await readFile(join(f.state, (await readdir(f.state)).find(name => name.endsWith('.result.json'))), 'utf8'));
  assert.equal(result.code, 'CONTINUATION_REQUEST_FAILED');
  assert.ok(!JSON.stringify(result).includes('synthetic network failure'));
});

test('a stalled SDK call expires without sending a continuation', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  await f.save({ ...f.descriptor, expiresAt: Date.now() + 150 });
  f.client.tool.ids = () => new Promise(() => {});
  const result = await f.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'CONTINUATION_TIMEOUT');
  assert.equal(f.calls.filter(([kind]) => kind === 'prompt').length, 0);
});

test('continuation preserves the selected model variant', async t => {
  const f = await fixture(t);
  await f.save({ ...f.descriptor, variant: 'high' });
  f.message.info.variant = 'high';
  assert.equal((await f.run()).status, 'resumed');
  assert.equal(f.calls.find(([kind]) => kind === 'prompt')[1].body.variant, 'high');
});
