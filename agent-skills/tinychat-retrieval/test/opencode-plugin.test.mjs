import { test } from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../lib/opencode-plugin.mjs');
const context = { status: 'access-required', profile: 'default', host: 'https://node.example.test', sessionDid: 'did:key:zFixture' };
const approvalUrl = 'https://openkey.example.test/delegate?synthetic=1';
function fixture() {
  const calls = [];
  let rejection;
  const setup = {
    authorize: async () => { calls.push({ authorize: true }); return { ...context, status: 'awaiting-approval', approvalUrl, message: 'Open this link and approve TinyChat access, then send me the short code OpenKey shows (like ABCD-EFGH).' }; },
    login: async code => {
      calls.push({ code });
      if (rejection) throw Object.assign(new Error('Send the code OpenKey showed, exactly as shown.'), { code: rejection });
      return { ...context, status: 'ready', retrievalArgs: ['--profile', 'default'], access: 'not-tested' };
    },
  };
  const hooks = module.createSigninHooks({ setup });
  const authorize = args => hooks.tool.tinychat_authorize.execute(args, { sessionID: 's1' }).then(JSON.parse);
  return { hooks, authorize, calls, reject: code => { rejection = code; } };
}

test('without a code, tinychat_authorize returns the OpenKey link and the one line to send', async () => {
  const { authorize, calls } = fixture();
  const result = await authorize({});
  assert.equal(result.ok, true);
  assert.equal(result.status, 'awaiting-approval');
  assert.equal(result.approvalUrl, approvalUrl);
  assert.match(result.message, /send me the short code/);
  assert.deepEqual(calls, [{ authorize: true }]);
});

test('the code the owner sent goes to setup.login exactly as sent', async () => {
  const { authorize, calls } = fixture();
  const result = await authorize({ code: 'AbCd-2345' });
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, [{ code: 'AbCd-2345' }]);
});

test('errors keep their code and say what to do; unknown arguments are refused', async () => {
  const { authorize, reject, calls } = fixture();
  reject('INVALID_AUTH_RESPONSE');
  const result = await authorize({ code: 'nope' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_AUTH_RESPONSE');
  assert.match(result.error.message, /exactly as shown/);
  for (const args of [{ configPath: '/tmp/x' }, { code: 7 }]) assert.equal((await authorize(args)).error.code, 'INVALID_INPUT');
  assert.equal(calls.length, 1);
});

test('the adapter has no chat capture hook or sign-in status tool', () => {
  const { hooks } = fixture();
  assert.equal(hooks['chat.message'], undefined);
  assert.deepEqual(Object.keys(hooks.tool), ['tinychat_authorize']);
  assert.doesNotMatch(hooks.tool.tinychat_authorize.description, /never pass a code/i);
});
