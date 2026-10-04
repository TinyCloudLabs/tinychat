import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    if (args.includes('caps')) return JSON.stringify({ covered: profiles.get(args[args.indexOf('--profile') + 1]).covered !== false });
    assert.ok(args.includes('context'));
    if (args.includes('--host')) assert.equal(args[args.indexOf('--host') + 1], config.host, 'explicit app host wins over inherited environment');
    const profile = args[args.indexOf('--profile') + 1];
    const p = profiles.get(profile);
    assert.ok(p);
    const space = args[args.indexOf('--space') + 1];
    return JSON.stringify(transform({ schemaVersion: 1, profile, sessionDid: 'did:key:zSession', spaceId: args.includes('--space') ? (space.startsWith('tinycloud:') ? space : `tinycloud:${p.ownerDid.slice(4)}:${space}`) : null, access: 'not-tested', ...p }, args));
  };
  const statePath = join(directory, 'setup.json');
  return { profiles, calls, statePath, setTransform: fn => { transform = fn; }, setup: createSetup({ runTc, statePath, manifestPath: new URL('../assets/permissions.json', import.meta.url) }) };
}
test('fresh setup preserves unrelated profiles and reaches ownerless scoped login with app host', async t => {
  const { setup, profiles, calls } = await fixture(t);
  const result = await setup.prepare({ config });
  assert.equal(result.status, 'login-required');
  assert.equal(result.profile, 'tinychat-agent-2');
  assert.equal(result.identityMatch, 'browser-selection-only');
  assert.ok(!result.loginArgs.includes('--owner'));
  assert.equal(result.loginArgs[result.loginArgs.indexOf('--host') + 1], config.host);
  const manifest = JSON.parse(Buffer.from(result.loginArgs[result.loginArgs.indexOf('--manifest') + 1].slice(7), 'base64').toString());
  assert.equal(manifest.space, 'applications');
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

async function selected(t, { authenticated = true, covered = true, space = 'account' } = {}) {
  const value = await fixture(t);
  const manifestPath = join(dirname(value.statePath), 'permissions.json');
  const manifest = { manifest_version: 1, app_id: 'xyz.example.records', name: 'Read records', defaults: false, includePublicSpace: false, space,
    permissions: [{ service: 'tinycloud.kv', path: 'registry/spaces', actions: ['get'], skipPrefix: true }] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  value.profiles.set('work', { host: config.host, ownerDid: authenticated ? owner : null, session: authenticated ? { state: 'present', expiresAt: '2099-01-01T00:00:00.000Z' } : { state: 'missing' }, covered });
  return { ...value, manifestPath, manifest, selectedConfig: { ...config, profile: 'work', space, manifestPath } };
}

test('selected existing profile reuses covered account access without creating or switching profiles', async t => {
  const { setup, selectedConfig, calls } = await selected(t);
  const result = await setup.prepare({ config: selectedConfig });
  assert.equal(result.profile, 'work');
  assert.equal(result.status, 'ready');
  assert.equal(result.space, `tinycloud:${owner.slice(4)}:account`);
  assert.equal(result.access, 'not-tested');
  assert.equal((await setup.authorize()).status, 'ready');
  assert.ok(!calls.some(args => args.includes('create') || args.includes('switch')));
});

test('selected account bootstrap preserves an unknown owner until browser verification', async t => {
  const { setup, selectedConfig, calls } = await selected(t, { authenticated: false });
  const result = await setup.prepare({ config: selectedConfig });
  assert.equal(result.status, 'login-required');
  assert.equal(result.profile, 'work');
  assert.ok(!result.loginArgs.includes('--owner'));
  assert.ok(!calls.some(args => args.includes('create')));
});

test('missing requested scope on a ready primary session requires an additional grant', async t => {
  const { setup, selectedConfig, profiles } = await selected(t, { covered: false });
  const result = await setup.prepare({ config: selectedConfig });
  assert.equal(result.status, 'grant-required');
  assert.equal(result.reason, 'missing-scope');
  assert.ok(result.loginArgs.includes('request') && result.loginArgs.includes('--grant'));
  assert.ok(!result.loginArgs.includes('login'));
  profiles.get('work').covered = true;
  assert.equal((await setup.context()).status, 'ready');
});

test('pending scoped approval rejects changed manifest content even at the same path', async t => {
  const { setup, selectedConfig, manifestPath, manifest } = await selected(t, { covered: false });
  const pending = await setup.prepare({ config: selectedConfig });
  await writeFile(manifestPath, JSON.stringify({ ...manifest, permissions: [{ ...manifest.permissions[0], path: 'registry/' }] }));
  await assert.rejects(setup.login('{}', { expectedContext: pending }), { code: 'APPROVAL_CONTEXT_CHANGED' });
});

test('selected absent profile is classified separately and never auto-created', async t => {
  const { setup, selectedConfig, profiles, calls } = await selected(t);
  profiles.delete('work');
  await assert.rejects(setup.prepare({ config: selectedConfig }), { code: 'PROFILE_NOT_FOUND' });
  assert.ok(!calls.some(args => args.includes('create')));
});

test('selected logical and full spaces keep the requested operation space', async t => {
  for (const space of ['records', `tinycloud:${owner.slice(4)}:records`]) {
    const { setup, selectedConfig } = await selected(t, { space });
    const result = await setup.prepare({ config: selectedConfig });
    assert.equal(result.status, 'ready');
    assert.equal(result.space, `tinycloud:${owner.slice(4)}:records`);
  }
});

test('pending selected context rejects a different inherited durable home', async t => {
  const { setup, selectedConfig } = await selected(t, { covered: false });
  const pending = await setup.prepare({ config: selectedConfig });
  const original = process.env.TC_HOME;
  try {
    process.env.TC_HOME = '/different/durable-home';
    await assert.rejects(setup.login('{}', { expectedContext: pending }), { code: 'APPROVAL_CONTEXT_CHANGED' });
  } finally {
    if (original === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = original;
  }
});

test('legacy saved profile adopts selected operation scope without losing owner or creating another account', async t => {
  const { setup, selectedConfig, profiles, calls, statePath } = await selected(t);
  const legacy = await setup.prepare({ config: { ...config, expectedOwner: owner } });
  profiles.get(legacy.profile).ownerDid = owner;
  profiles.get(legacy.profile).session = { state: 'present', expiresAt: '2099-01-01T00:00:00.000Z' };
  await setup.context();
  const before = calls.filter(args => args.includes('create')).length;
  const adopted = await setup.prepare({ config: { ...selectedConfig, profile: legacy.profile } });
  assert.equal(adopted.status, 'ready');
  assert.equal(adopted.profile, legacy.profile);
  assert.equal(adopted.owner, owner);
  const saved = JSON.parse(await readFile(statePath));
  assert.equal(saved.owner, owner);
  assert.equal(saved.config.expectedOwner, owner);
  assert.equal(calls.filter(args => args.includes('create')).length, before);
  await assert.rejects(setup.prepare({ config: selectedConfig }), { code: 'CONTEXT_MISMATCH' });
});

test('malformed selected manifest and profile types remain configuration errors', async t => {
  const { setup, selectedConfig, manifestPath, manifest } = await selected(t);
  await writeFile(manifestPath, 'null');
  await assert.rejects(setup.prepare({ config: selectedConfig }), { code: 'SETUP_CONFIG_INVALID' });
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(setup.prepare({ config: { ...selectedConfig, profile: 123 } }), { code: 'SETUP_CONFIG_INVALID' });
});
