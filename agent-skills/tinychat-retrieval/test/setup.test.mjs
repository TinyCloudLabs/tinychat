import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetup } from '../lib/setup.mjs';

const owner = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';
const other = 'did:pkh:eip155:1:0x2222222222222222222222222222222222222222';
const config = { schemaVersion: 1, host: 'https://custom.example.test', space: 'applications' };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tinychat-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profiles = new Map([['tinychat-agent', { ownerDid: other, host: config.host, session: { state: 'present', expiresAt: '2099-01-01T00:00:00.000Z' } }]]);
  const calls = [];
  let transform = value => value;
  const runTc = async args => {
    calls.push(args);
    if (args.includes('--version')) return '0.10.0';
    if (args.includes('list')) return JSON.stringify({ profiles: [...profiles.keys()].map(name => ({ name, host: profiles.get(name).host })) });
    if (args.includes('create')) {
      const name = args[args.indexOf('create') + 1];
      assert.ok(!profiles.has(name));
      profiles.set(name, { ownerDid: null, host: args[args.indexOf('--host') + 1], session: { state: 'missing' } });
      return '{}';
    }
    assert.ok(args.includes('context'));
    if (args.includes('--host')) assert.equal(args[args.indexOf('--host') + 1], config.host, 'explicit app host wins over inherited environment');
    const profile = args[args.indexOf('--profile') + 1];
    const p = profiles.get(profile);
    assert.ok(p);
    return JSON.stringify(transform({ schemaVersion: 1, profile, sessionDid: 'did:key:zSession', spaceId: args.includes('--space') ? `tinycloud:${p.ownerDid.slice(4)}:applications` : null, access: 'not-tested', ...p }, args));
  };
  const statePath = join(directory, 'setup.json');
  return { profiles, calls, statePath, setTransform: fn => { transform = fn; }, setup: createSetup({ runTc, statePath, manifestPath: '/installed/assets/permissions.json' }) };
}
test('fresh setup preserves unrelated profiles and reaches ownerless scoped login with app host', async t => {
  const { setup, profiles, calls } = await fixture(t);
  const result = await setup.prepare({ config });
  assert.equal(result.status, 'login-required');
  assert.equal(result.profile, 'tinychat-agent-2');
  assert.equal(result.identityMatch, 'browser-selection-only');
  assert.ok(!result.loginArgs.includes('--owner'));
  assert.equal(result.loginArgs[result.loginArgs.indexOf('--host') + 1], config.host);
  assert.ok(result.loginArgs.includes('/installed/assets/permissions.json'));
  assert.equal(profiles.get('tinychat-agent').ownerDid, other);
  assert.ok(!calls.some(a => a.includes('switch')));
});
test('verified primary owner and resolved space bind retrieval and survive a return visit', async t => {
  const { setup, profiles, calls } = await fixture(t);
  const first = await setup.prepare({ config });
  profiles.get(first.profile).ownerDid = owner;
  profiles.get(first.profile).session = { state: 'present', expiresAt: '2099-01-01T00:00:00.000Z' };
  const result = await setup.context();
  assert.equal(result.status, 'ready');
  assert.equal(result.owner, owner);
  assert.equal(result.space, `tinycloud:${owner.slice(4)}:applications`);
  assert.deepEqual(result.retrievalArgs, ['--profile', first.profile, '--host', config.host, '--space', result.space, '--owner', owner]);
  const returned = await setup.prepare();
  assert.equal(returned.status, 'ready');
  assert.equal(returned.loginArgs, undefined);
  assert.equal(calls.filter(a => a.includes('create')).length, 1);
});
test('automatic expected owner is included and wrong signing key is rejected without binding it', async t => {
  const { setup, profiles, statePath } = await fixture(t);
  const first = await setup.prepare({ config: { ...config, expectedOwner: owner } });
  assert.equal(first.loginArgs.at(-1), owner);
  profiles.get(first.profile).ownerDid = other;
  profiles.get(first.profile).session = { state: 'present', expiresAt: '2099-01-01T00:00:00.000Z' };
  await assert.rejects(setup.context(), { code: 'OWNER_MISMATCH' });
  assert.equal(JSON.parse(await readFile(statePath)).owner, undefined);
});
test('saved account and host cannot silently drift; explicit new profile preserves old authority', async t => {
  const { setup, profiles } = await fixture(t);
  const first = await setup.prepare({ config });
  profiles.get(first.profile).ownerDid = owner;
  profiles.get(first.profile).session = { state: 'present', expiresAt: '2099-01-01T00:00:00.000Z' };
  await setup.context();
  await assert.rejects(setup.prepare({ config: { ...config, expectedOwner: other } }), { code: 'OWNER_MISMATCH' });
  await assert.rejects(setup.prepare({ config: { ...config, host: 'https://other.example.test' } }), { code: 'CONTEXT_MISMATCH' });
  profiles.get(first.profile).host = 'https://unexpected.example.test';
  await assert.rejects(setup.context(), { code: 'CONTEXT_MISMATCH' });
  const next = await setup.prepare({ config: { ...config, expectedOwner: other }, newProfile: true });
  assert.notEqual(next.profile, first.profile);
  assert.equal(profiles.get(first.profile).ownerDid, owner);
});
test('expired authority needs consent for the saved owner, without changing selected profile', async t => {
  const { setup, profiles } = await fixture(t);
  const first = await setup.prepare({ config });
  profiles.get(first.profile).ownerDid = owner;
  profiles.get(first.profile).session = { state: 'present', expiresAt: '2099-01-01T00:00:00.000Z' };
  await setup.context();
  profiles.get(first.profile).session = { state: 'expired' };
  const expired = await setup.prepare();
  assert.equal(expired.status, 'login-required');
  assert.equal(expired.reason, 'expired');
  assert.equal(expired.loginArgs.at(-1), owner);
  assert.equal(expired.profile, first.profile);
});
test('missing or ambiguous app configuration fails before creating a profile', async t => {
  const { setup, calls } = await fixture(t);
  await assert.rejects(setup.prepare(), { code: 'SETUP_CONFIG_REQUIRED' });
  for (const invalid of [{ ...config, host: undefined }, { ...config, host: [config.host] }, { ...config, space: 'default' }, { ...config, expectedOwner: 'did:key:zSession' }]) {
    await assert.rejects(setup.prepare({ config: invalid }), { code: 'SETUP_CONFIG_INVALID' });
  }
  assert.ok(!calls.some(a => a.includes('create')));
});

test('conflicting structured context cannot bind a different owner or case-sensitive space', async t => {
  const { setup, profiles, setTransform } = await fixture(t);
  const first = await setup.prepare({ config });
  profiles.get(first.profile).ownerDid = owner;
  profiles.get(first.profile).session = { state: 'present', expiresAt: '2099-01-01T00:00:00.000Z' };
  setTransform((value, args) => args.includes('--space') ? { ...value, ownerDid: other, spaceId: `tinycloud:${other.slice(4)}:applications` } : value);
  await assert.rejects(setup.context(), { code: 'CONTEXT_MISMATCH' });
  setTransform(value => ({ ...value, spaceId: value.spaceId?.replace(':applications', ':Applications') ?? null }));
  await assert.rejects(setup.context(), { code: 'CONTEXT_MISMATCH' });
  setTransform(value => ({ ...value, session: { state: 'present', expiresAt: '2020-01-01T00:00:00.000Z' } }));
  await assert.rejects(setup.context(), { code: 'INVALID_RESPONSE' });
});


test('chat transport rechecks pending profile, host, key and login arguments at the verifier boundary', async t => {
  const { setup } = await fixture(t);
  const context = await setup.prepare({ config });
  assert.equal(context.sessionDid, 'did:key:zSession');
  for (const change of [{ profile: 'other' }, { host: 'https://other.example.test' }, { sessionDid: 'did:key:zOther' }, { loginArgs: ['different'] }]) {
    await assert.rejects(setup.login('{}', { expectedContext: { ...context, ...change } }), { code: 'APPROVAL_CONTEXT_CHANGED' });
  }
});

test('operation guard checks saved setup and current bound owner/key/expiry with one official scoped context command', async t => {
  const { setup, profiles, calls, statePath, setTransform } = await fixture(t);
  const prepared = await setup.prepare({ config });
  profiles.get(prepared.profile).ownerDid = owner;
  profiles.get(prepared.profile).session = { state: 'present', expiresAt: '2099-01-01T00:00:00.000Z' };
  const bound = await setup.context();
  const start = calls.length;
  const current = await setup.guard(bound);
  assert.equal(current.sessionDid, bound.sessionDid);
  assert.equal(calls.length - start, 1);
  assert.ok(calls.at(-1).includes('context'));
  assert.equal(calls.at(-1)[calls.at(-1).indexOf('--space')+1], 'applications');
  setTransform(value => ({...value,sessionDid:'did:key:changed'}));
  await assert.rejects(setup.guard(bound),{code:'CONTEXT_MISMATCH'});
  setTransform(value=>({...value,session:{state:'expired'}}));
  await assert.rejects(setup.guard(bound),{code:'AUTH_EXPIRED'});
  setTransform(value=>({...value,ownerDid:other}));
  await assert.rejects(setup.guard(bound),{code:'OWNER_MISMATCH'});
  setTransform(value=>value);
  const saved=JSON.parse(await readFile(statePath,'utf8'));
  saved.profile='tinychat-agent-3';
  const {writeFile}=await import('node:fs/promises');
  await writeFile(statePath,JSON.stringify(saved));
  const before=calls.length;
  await assert.rejects(setup.guard(bound),{code:'CONTEXT_MISMATCH'});
  assert.equal(calls.length,before,'changed selected setup fails before a CLI launch');
});
