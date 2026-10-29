import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetup, DEFAULT_CONFIG, ONBOARDING_URL, TINYCHAT_CAPS } from '../lib/setup.mjs';

const owner = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';
const other = 'did:pkh:eip155:1:0x2222222222222222222222222222222222222222';
const config = { schemaVersion: 1, host: 'https://custom.example.test', space: 'applications' };
const present = { state: 'present', expiresAt: '2099-01-01T00:00:00.000Z' };
async function fixture(t, { profile, host = config.host, version = '1.5.0-beta.28' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tinychat-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profiles = new Map([['default', { ownerDid: owner, host, session: present }], ['unrelated', { ownerDid: other, host, session: present }]]);
  const covered = new Set(TINYCHAT_CAPS);
  const calls = [];
  let transform = value => value;
  const runTc = async args => {
    calls.push(args);
    if (args.includes('--version')) return version;
    if (args.includes('list')) return JSON.stringify({ profiles: [...profiles.keys()].map(name => ({ name, host: profiles.get(name).host })) });
    assert.ok(!args.includes('create'), 'setup never creates a profile');
    if (args.includes('--host')) assert.equal(args[args.indexOf('--host') + 1], host, 'explicit app host wins over inherited environment');
    const name = args[args.indexOf('--profile') + 1];
    const p = profiles.get(name);
    assert.ok(p);
    if (args.includes('caps')) return JSON.stringify({ covered: covered.has(args[args.indexOf('--diff') + 1]) });
    assert.ok(args.includes('context'));
    return JSON.stringify(transform({ schemaVersion: 1, profile: name, sessionDid: 'did:key:zSession', spaceId: args.includes('--space') ? `tinycloud:${p.ownerDid.slice(4)}:applications` : null, ...p }, args));
  };
  const statePath = join(directory, 'setup.json');
  return { profiles, covered, calls, statePath, setTransform: fn => { transform = fn; }, setup: createSetup({ runTc, statePath, executable: '/nonexistent/tinycloud', ...(profile ? { profile } : {}) }) };
}

test('prepare binds the onboarding default profile with the TinyCloud host and creates nothing', async t => {
  const { setup, calls, statePath } = await fixture(t, { host: DEFAULT_CONFIG.host });
  const result = await setup.prepare();
  assert.equal(result.status, 'ready');
  assert.equal(result.profile, 'default');
  assert.equal(result.host, 'https://tee.node.tinycloud.xyz');
  assert.equal(result.identityMatch, 'onboarding-profile');
  assert.deepEqual(result.retrievalArgs, ['--profile', 'default', '--host', DEFAULT_CONFIG.host, '--space', `tinycloud:${owner.slice(4)}:applications`, '--owner', owner]);
  assert.ok(!calls.some(a => a.includes('create') || a.includes('switch') || a.includes('login')));
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), { schemaVersion: 1, profile: 'default', config: DEFAULT_CONFIG });
});

test('TC_PROFILE selects the onboarding profile', async t => {
  const { setup } = await fixture(t, { profile: 'unrelated' });
  const result = await setup.prepare({ config });
  assert.equal(result.profile, 'unrelated');
  assert.equal(result.owner, other);
});

test('a missing profile or expired session points to onboarding, not a separate sign-in', async t => {
  const { setup, profiles, calls } = await fixture(t);
  profiles.get('default').session = { state: 'expired' };
  const expired = await setup.prepare({ config });
  assert.equal(expired.status, 'onboarding-required');
  assert.equal(expired.reason, 'expired');
  assert.equal(expired.onboardingUrl, ONBOARDING_URL);
  assert.equal(expired.loginArgs, undefined);
  profiles.delete('default');
  const missing = await setup.prepare();
  assert.equal(missing.status, 'onboarding-required');
  assert.equal(missing.reason, 'profile-missing');
  assert.ok(!calls.some(a => a.includes('login') || a.includes('request')));
});

test('a profile without TinyChat reads reports access-required', async t => {
  const { setup, covered, calls } = await fixture(t);
  covered.delete(TINYCHAT_CAPS[1]);
  const result = await setup.prepare({ config });
  assert.equal(result.status, 'access-required');
  assert.equal(result.retrievalArgs, undefined);
  assert.deepEqual(calls.filter(a => a.includes('caps')).map(a => a.at(-1)), TINYCHAT_CAPS);
});

test('old CLI releases are refused before setup is saved', async t => {
  const { setup, statePath } = await fixture(t, { version: '1.3.0' });
  await assert.rejects(setup.prepare({ config }), { code: 'CLI_VERSION' });
  await assert.rejects(readFile(statePath), { code: 'ENOENT' });
});

test('an earlier tinychat-agent setup is rebound to the onboarding profile', async t => {
  const { setup, statePath } = await fixture(t);
  await writeFile(statePath, JSON.stringify({ schemaVersion: 1, profile: 'tinychat-agent', owner: other, config }));
  const result = await setup.prepare();
  assert.equal(result.status, 'ready');
  assert.equal(result.profile, 'default');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).profile, 'default');
});

test('app expected owner is kept across a generic prompt and a different account is rejected', async t => {
  const { setup, profiles } = await fixture(t);
  assert.equal((await setup.prepare({ config: { ...config, expectedOwner: owner } })).identityMatch, 'app-expected-owner');
  profiles.get('default').ownerDid = other;
  await assert.rejects(setup.prepare({ config }), { code: 'OWNER_MISMATCH' });
  await assert.rejects(setup.context(), { code: 'OWNER_MISMATCH' });
});

test('invalid app configuration, profile host or profile name fail', async t => {
  const { setup, profiles } = await fixture(t);
  for (const invalid of [{ ...config, host: undefined }, { ...config, host: [config.host] }, { ...config, space: 'default' }, { ...config, expectedOwner: 'did:key:zSession' }]) {
    await assert.rejects(setup.prepare({ config: invalid }), { code: 'SETUP_CONFIG_INVALID' });
  }
  profiles.get('default').host = 'https://unexpected.example.test';
  await assert.rejects(setup.prepare({ config }), { code: 'CONTEXT_MISMATCH' });
  const named = await fixture(t, { profile: '../escape' });
  await assert.rejects(named.setup.prepare({ config }), { code: 'SETUP_CONFIG_INVALID' });
});

test('conflicting structured context cannot bind a different owner or case-sensitive space', async t => {
  const { setup, setTransform } = await fixture(t);
  await setup.prepare({ config });
  setTransform((value, args) => args.includes('--space') ? { ...value, ownerDid: other, spaceId: `tinycloud:${other.slice(4)}:applications` } : value);
  await assert.rejects(setup.context(), { code: 'CONTEXT_MISMATCH' });
  setTransform(value => ({ ...value, spaceId: value.spaceId?.replace(':applications', ':Applications') ?? null }));
  await assert.rejects(setup.context(), { code: 'CONTEXT_MISMATCH' });
  setTransform(value => ({ ...value, session: { state: 'present', expiresAt: '2020-01-01T00:00:00.000Z' } }));
  await assert.rejects(setup.context(), { code: 'INVALID_RESPONSE' });
});

test('operation guard checks saved setup and current bound owner/key/expiry with one official scoped context command', async t => {
  const { setup, calls, statePath, setTransform } = await fixture(t);
  await setup.prepare({ config });
  const bound = await setup.context();
  const start = calls.length;
  const current = await setup.guard(bound);
  assert.equal(current.sessionDid, bound.sessionDid);
  assert.equal(calls.length - start, 1);
  assert.ok(calls.at(-1).includes('context'));
  assert.equal(calls.at(-1)[calls.at(-1).indexOf('--space') + 1], 'applications');
  setTransform(value => ({ ...value, sessionDid: 'did:key:changed' }));
  await assert.rejects(setup.guard(bound), { code: 'CONTEXT_MISMATCH' });
  setTransform(value => ({ ...value, session: { state: 'expired' } }));
  await assert.rejects(setup.guard(bound), { code: 'AUTH_EXPIRED' });
  setTransform(value => ({ ...value, ownerDid: other }));
  await assert.rejects(setup.guard(bound), { code: 'OWNER_MISMATCH' });
  setTransform(value => value);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  saved.profile = 'unrelated';
  await writeFile(statePath, JSON.stringify(saved));
  const before = calls.length;
  await assert.rejects(setup.guard(bound), { code: 'CONTEXT_MISMATCH' });
  assert.equal(calls.length, before, 'changed selected setup fails before a CLI launch');
});
