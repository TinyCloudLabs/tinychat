import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const module = await import('../lib/opencode-plugin.mjs').catch(() => ({}));
const context = { status: 'login-required', profile: 'tinychat-agent', host: 'https://node.example.test', sessionDid: 'did:key:zFixture', loginArgs: ['--profile', 'tinychat-agent'] };
// Repeated > and ? create base64 + and /; padding and whitespace exercise accepted input.
const value = { delegationHeader: { Authorization: 'synthetic-proof-'.repeat(450) }, note: '>>>>>>?????? synthetic onlyx' };
const encoded = '  ' + Buffer.from(JSON.stringify(value)).toString('base64') + '\n';
async function fixture(t) {
  assert.equal(typeof module.createSigninHooks, 'function', 'the client-input adapter must exist');
  const dir = await mkdtemp(join(tmpdir(), 'tinychat-plugin-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const artifactPath = join(dir, 'approval.html');
  await writeFile(artifactPath, 'synthetic approval', { mode: 0o600 });
  const calls = [];
  let selected = { ...context }, rejection, launches = 0;
  const setup = {
    context: async () => selected,
    authorize: async () => { launches++; return { ...selected, status: 'awaiting-approval', delivery: { mode: 'browser', status: 'launch-requested', artifactPath, instructions: 'Complete sign-in in the browser, then paste the code here.' } }; },
    login: async (raw, options) => {
      calls.push({ raw, options });
      if (rejection) throw Object.assign(new Error('PRIVATE: ' + raw), { code: rejection });
      return { ...selected, status: 'ready', retrievalArgs: ['--profile', selected.profile], access: 'not-tested' };
    },
  };
  const hooks = module.createSigninHooks({ setup });
  const authorize = (sessionID = 's1') => hooks.tool.tinychat_authorize.execute({}, { sessionID });
  const send = async (raw, { sessionID = 's1', id = 'm1', parts } = {}) => {
    const output = { message: { id, sessionID, role: 'user' }, parts: parts ?? [{ type: 'text', text: raw }] };
    await hooks['chat.message']({ sessionID }, output);
    return output;
  };
  return { hooks, send, authorize, calls, artifactPath, setContext: x => { selected = x; }, reject: x => { rejection = x; }, launches: () => launches };
}

test('original accepted 8–12 KB chat text is transported verbatim with only a small model receipt', async t => {
  const f = await fixture(t);
  assert.ok(Buffer.byteLength(encoded) >= 8192 && Buffer.byteLength(encoded) <= 12288);
  assert.match(encoded, /\+/); assert.match(encoded, /\//); assert.match(encoded, /=/);
  await f.authorize();
  const output = await f.send(encoded);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].raw, encoded);
  assert.deepEqual(f.calls[0].options.expectedContext, context);
  assert.ok(JSON.stringify(output).length < 2500);
  assert.ok(!JSON.stringify(output).includes(encoded.trim()));
  assert.match(output.parts[0].text, /ready/);
  await assert.rejects(stat(f.artifactPath), { code: 'ENOENT' });
});

test('multiline JSON and synthetic editor context preserve original accepted text', async t => {
  const f = await fixture(t); await f.authorize();
  const raw = JSON.stringify(value, null, 2) + '\n';
  const output = await f.send(null, { parts: [{ type: 'text', text: 'Editor context', synthetic: true }, { type: 'text', text: raw }] });
  assert.equal(f.calls[0].raw, raw);
  assert.equal(output.parts[0].text, 'Editor context');
  assert.match(output.parts[1].text, /ready/);
});

test('missing text leaves approval pending; repeated authorization does not reopen browser', async t => {
  const f = await fixture(t); await f.authorize();
  assert.equal((await f.send('The browser has not appeared')).parts[0].text, 'The browser has not appeared');
  await f.authorize();
  assert.equal(f.launches(), 1);
  assert.equal(f.calls.length, 0);
  assert.ok(await stat(f.artifactPath));
  assert.match(await f.hooks.tool.tinychat_signin_status.execute({}, { sessionID: 's1' }), /awaiting-approval/);
});

test('another session cannot consume approval and profile/session-key changes reject before login', async t => {
  const f = await fixture(t); await f.authorize();
  const other = await f.send(encoded, { sessionID: 's2' });
  assert.match(other.parts[0].text, /NO_PENDING_APPROVAL/);
  assert.equal(f.calls.length, 0);
  assert.match(await f.authorize('s2'), /APPROVAL_IN_ANOTHER_SESSION/);
  for (const changed of [{ profile: 'tinychat-agent-2' }, { sessionDid: 'did:key:zChanged' }, { host: 'https://other.example.test' }, { loginArgs: ['--owner', 'changed'] }]) {
    f.setContext({ ...context, ...changed });
    const result = await f.send(encoded, { id: JSON.stringify(changed) });
    assert.match(result.parts[0].text, /APPROVAL_CONTEXT_CHANGED/);
    assert.equal(f.calls.length, 0);
  }
  assert.ok(await stat(f.artifactPath));
});

test('ambiguous and truncated input fail privately; helper rejection codes survive', async t => {
  const f = await fixture(t); await f.authorize();
  const ambiguous = await f.send(null, { parts: [{ type: 'text', text: encoded }, { type: 'text', text: encoded }] });
  assert.match(ambiguous.parts[0].text, /AMBIGUOUS_AUTH_RESPONSE/);
  assert.ok(!JSON.stringify(ambiguous).includes(encoded.trim()));
  assert.equal(f.calls.length, 0);
  for (const code of ['INVALID_AUTH_RESPONSE', 'OPENKEY_PROOF_INVALID', 'OWNER_MISMATCH', 'OPENKEY_SCOPE_MISMATCH', 'OPENKEY_GRANT_BROADENED', 'AUTH_EXPIRED']) {
    f.reject(code);
    const result = await f.send(code === 'INVALID_AUTH_RESPONSE' ? encoded.slice(0, -50) : encoded, { id: code });
    assert.match(result.parts[0].text, new RegExp(code));
    assert.ok(!JSON.stringify(result).includes('PRIVATE:'));
    assert.match(result.parts[0].text, /"ok":false/);
  }
  assert.ok(await stat(f.artifactPath), 'rejection must not remove pending approval');
});

test('duplicate message or response does not verify twice', async t => {
  const f = await fixture(t); await f.authorize();
  const first = await f.send(encoded);
  const duplicate = await f.send(encoded);
  const repeated = await f.send(encoded, { id: 'm2' });
  assert.equal(f.calls.length, 1);
  assert.match(duplicate.parts[0].text, /DUPLICATE_AUTH_RESPONSE/);
  assert.match(repeated.parts[0].text, /DUPLICATE_AUTH_RESPONSE/);
  assert.match(first.parts[0].text, /ready/);
});


test('ordinary JSON outside a pending approval remains chat data; short truncated code is captured', async t => {
  const f = await fixture(t);
  const ordinary = '{"name":"a normal data example"}';
  assert.equal((await f.send(ordinary)).parts[0].text, ordinary);
  await f.authorize();
  f.reject('INVALID_AUTH_RESPONSE');
  const result = await f.send('eyJ...TRUNCATED', { id: 'short' });
  assert.match(result.parts[0].text, /INVALID_AUTH_RESPONSE/);
  assert.ok(!result.parts[0].text.includes('eyJ'));
});

test('expired approval allows a new authorization while preserving its old artifact', async t => {
  const f = await fixture(t); await f.authorize();
  f.reject('AUTH_EXPIRED');
  await f.send(encoded);
  assert.ok(await stat(f.artifactPath));
  await f.authorize();
  assert.equal(f.launches(), 2);
  assert.match(await f.hooks.tool.tinychat_signin_status.execute({}, { sessionID: 's1' }), /awaiting-approval/);
});

test('overlapping responses verify once and retain explicit concurrent failure', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const hooks = module.createSigninHooks({ setup: {
    context: async () => context,
    authorize: async () => ({ ...context, status: 'awaiting-approval' }),
    login: async () => { calls++; await wait; return { ...context, status: 'ready' }; },
  } });
  await hooks.tool.tinychat_authorize.execute({}, { sessionID: 's1' });
  const message = id => ({ message: { id, sessionID: 's1' }, parts: [{ type: 'text', text: encoded }] });
  const first = message('first'), second = message('second');
  const running = hooks['chat.message']({ sessionID: 's1' }, first);
  await hooks['chat.message']({ sessionID: 's1' }, second);
  assert.match(second.parts[0].text, /AUTH_CAPTURE_IN_PROGRESS/);
  release(); await running;
  assert.equal(calls, 1);
  assert.match(first.parts[0].text, /ready/);
});


test('approval acquisition cannot arm a different context, and opener failure still allows capture', async () => {
  const hooks = module.createSigninHooks({ setup: {
    context: async () => context,
    authorize: async () => ({ ...context, profile: 'changed-during-authorization', status: 'awaiting-approval' }),
  } });
  assert.match(await hooks.tool.tinychat_authorize.execute({}, { sessionID: 's1' }), /APPROVAL_CONTEXT_CHANGED/);
  const failedOpener = module.createSigninHooks({ setup: {
    context: async () => context,
    authorize: async () => { throw Object.assign(new Error('PRIVATE URL'), { code: 'BROWSER_OPEN_FAILED', delivery: { status: 'file-created' } }); },
    login: async () => ({ ...context, status: 'ready' }),
  } });
  assert.match(await failedOpener.tool.tinychat_authorize.execute({}, { sessionID: 's1' }), /BROWSER_OPEN_FAILED/);
  const output = { message: { id: 'm1', sessionID: 's1' }, parts: [{ type: 'text', text: encoded }] };
  await failedOpener['chat.message']({ sessionID: 's1' }, output);
  assert.match(output.parts[0].text, /ready/);
  assert.ok(!output.parts[0].text.includes('PRIVATE URL'));
});
