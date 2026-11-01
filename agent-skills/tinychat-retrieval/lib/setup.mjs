import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compareSemver, createTcRunner, defaultTc, SETUP_CLI_VERSION } from './retrieval.mjs';
import { runGrant, responseInput } from './login.mjs';

export const ONBOARDING_URL = 'https://agents.tinycloud.xyz/onboarding';
export const DEFAULT_CONFIG = Object.freeze({ schemaVersion: 1, host: 'https://tee.node.tinycloud.xyz', space: 'applications' });
/** TinyChat's reads. Onboarding's starting grant covers them; any other profile asks once. */
export const TINYCHAT_CAPS = Object.freeze([
  'tinycloud.sql:applications:xyz.tinycloud.tinychat/connectors:read',
  'tinycloud.kv:applications:xyz.tinycloud.tinychat/connectors/:get',
]);
const APPROVAL_MESSAGE = 'Open this link and approve TinyChat access, then send me the short code OpenKey shows (like ABCD-EFGH).';

const messages = {
  SETUP_CONFIG_REQUIRED: 'Run setup.mjs prepare (or tinychat_setup) before starting retrieval.',
  SETUP_CONFIG_INVALID: 'TinyChat setup metadata or TC_PROFILE is invalid. Correct the app configuration or the profile name.',
  INVALID_RESPONSE: 'The CLI returned incomplete or conflicting context.',
  CONTEXT_MISMATCH: 'The TinyCloud profile uses a different host or space than TinyChat. Run onboarding with the intended account: https://agents.tinycloud.xyz/onboarding',
  OWNER_MISMATCH: 'This profile is signed in with a different account than TinyChat expects. Run onboarding with the account you use for TinyChat: https://agents.tinycloud.xyz/onboarding',
  CLI_VERSION: `This setup needs TinyCloud CLI ${SETUP_CLI_VERSION} or later. https://agents.tinycloud.xyz/onboarding installs it.`,
};
const fail = code => { throw Object.assign(new Error(messages[code]), { code }); };
const primary = v => typeof v === 'string' && /^did:pkh:eip155:[1-9][0-9]*:0x[a-fA-F0-9]{40}$/.test(v);
const profileName = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v);
function host(value) {
  let url;
  try { url = new URL(value); } catch { fail('SETUP_CONFIG_INVALID'); }
  if (typeof value !== 'string' || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('SETUP_CONFIG_INVALID');
  return url.origin;
}
export function validateConfig(value) {
  if (!value || value.schemaVersion !== 1 || value.space !== 'applications' || (value.expectedOwner !== undefined && !primary(value.expectedOwner))) fail('SETUP_CONFIG_INVALID');
  return { schemaVersion: 1, host: host(value.host), space: 'applications', ...(value.expectedOwner === undefined ? {} : { expectedOwner: value.expectedOwner }) };
}
const sameOwner = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Binds the onboarding profile (TC_PROFILE, else `default`). The official CLI verifies every approval. */
export function createSetup({ runTc = createTcRunner(), statePath, executable = defaultTc(), profile = process.env.TC_PROFILE || 'default' }) {
  async function load() {
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; fail('SETUP_CONFIG_INVALID'); }
    if (state.schemaVersion !== 1 || !profileName(state.profile)) fail('SETUP_CONFIG_INVALID');
    return { schemaVersion: 1, profile: state.profile, config: validateConfig(state.config) };
  }
  async function save(state) {
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, statePath);
  }
  /** The saved app configuration, bound to the onboarding profile. */
  async function current(supplied) {
    if (!profileName(profile)) fail('SETUP_CONFIG_INVALID');
    const saved = await load();
    const config = supplied === undefined ? (saved?.config ?? { ...DEFAULT_CONFIG }) : validateConfig(supplied);
    // A generic public prompt must not erase an earlier app identity check.
    if (!config.expectedOwner && saved?.config.expectedOwner) config.expectedOwner = saved.config.expectedOwner;
    return { schemaVersion: 1, profile, config };
  }
  async function json(args) {
    const raw = await runTc(args);
    try { return JSON.parse(raw); } catch { fail('INVALID_RESPONSE'); }
  }
  const grantArgs = state => ['--profile', state.profile, '--host', state.config.host, 'auth', 'request',
    ...TINYCHAT_CAPS.flatMap(cap => ['--cap', cap]), '--grant', '--paste', '--expiry', '30d'];
  async function inspect(state, { access = false } = {}) {
    const common = { schemaVersion: 1, profile: state.profile, host: state.config.host };
    const onboarding = reason => ({ ...common, status: 'onboarding-required', reason, onboardingUrl: ONBOARDING_URL,
      next: `Set up TinyCloud with ${ONBOARDING_URL}, then run prepare again.` });
    const listed = await json(['--json', 'profile', 'list']);
    if (!Array.isArray(listed.profiles)) fail('INVALID_RESPONSE');
    const stored = listed.profiles.find(entry => entry.name === state.profile);
    if (!stored) return onboarding('profile-missing');
    if (host(stored.host) !== state.config.host) fail('CONTEXT_MISMATCH');
    const base = ['--profile', state.profile, '--host', state.config.host, '--json', 'context'];
    let value = await json(base);
    function validate() {
      if (value.schemaVersion !== 1 || value.profile !== state.profile || !['missing', 'expired', 'present', 'unknown-expiry'].includes(value.session?.state)) fail('INVALID_RESPONSE');
      if (typeof value.sessionDid !== 'string' || !value.sessionDid.startsWith('did:key:')) fail('INVALID_RESPONSE');
      if (value.session.state === 'present' && (!Number.isFinite(Date.parse(value.session.expiresAt)) || Date.parse(value.session.expiresAt) <= Date.now())) fail('INVALID_RESPONSE');
      if (host(value.host) !== state.config.host) fail('CONTEXT_MISMATCH');
      if (value.ownerDid !== null && !primary(value.ownerDid)) fail('INVALID_RESPONSE');
      if (state.config.expectedOwner && value.ownerDid && !sameOwner(state.config.expectedOwner, value.ownerDid)) fail('OWNER_MISMATCH');
    }
    validate();
    if (['missing', 'expired'].includes(value.session.state)) return onboarding(value.session.state);
    if (!primary(value.ownerDid)) fail('INVALID_RESPONSE');
    const first = value;
    value = await json([...base, '--space', state.config.space]);
    validate();
    if (!primary(value.ownerDid) || !['present', 'unknown-expiry'].includes(value.session.state)) fail('INVALID_RESPONSE');
    if (!sameOwner(value.ownerDid, first.ownerDid) || value.sessionDid !== first.sessionDid) fail('CONTEXT_MISMATCH');
    const expectedSpace = `tinycloud:${value.ownerDid.slice(4)}:${state.config.space}`;
    if (typeof value.spaceId !== 'string' || value.spaceId.toLowerCase() !== expectedSpace.toLowerCase() || !value.spaceId.endsWith(`:${state.config.space}`)) fail('CONTEXT_MISMATCH');
    const identityMatch = state.config.expectedOwner ? 'app-expected-owner' : 'onboarding-profile';
    const bound = { ...common, sessionDid: value.sessionDid, identityMatch, owner: value.ownerDid, space: value.spaceId, session: value.session };
    if (access) {
      for (const cap of TINYCHAT_CAPS) {
        const diff = await json(['--profile', state.profile, '--host', state.config.host, '--json', 'auth', 'caps', '--diff', cap]);
        if (typeof diff.covered !== 'boolean') fail('INVALID_RESPONSE');
        if (!diff.covered) return { ...bound, status: 'access-required', next: 'Run authorize, send the owner approvalUrl with its message, then run login with the code they send back.' };
      }
    }
    const retrievalArgs = ['--profile', state.profile, '--host', state.config.host, '--space', value.spaceId, '--owner', value.ownerDid];
    return { ...bound, status: 'ready', access: 'not-tested', retrievalArgs };
  }
  return {
    async prepare({ config } = {}) {
      const state = await current(config);
      const version = (await runTc(['--version'])).trim().replace(/^(?:tinycloud|tc)\s+/, '');
      const comparison = compareSemver(version, SETUP_CLI_VERSION);
      if (Number.isNaN(comparison) || comparison < 0) fail('CLI_VERSION');
      await save(state);
      return inspect(state, { access: true });
    },
    async context() {
      const state = await current();
      const result = await inspect(state);
      if (result.status === 'ready') await save(state);
      return result;
    },
    async guard(bound) {
      const state = await load();
      if (!state) fail('SETUP_CONFIG_REQUIRED');
      if (!bound || bound.profile !== state.profile || bound.host !== state.config.host ||
          !bound.space?.endsWith(`:${state.config.space}`) ||
          (state.config.expectedOwner && !sameOwner(state.config.expectedOwner, bound.owner))) fail('CONTEXT_MISMATCH');
      // Do not override host here: a changed CLI profile or inherited host must
      // be observed and rejected against the acquisition's verified binding.
      const value = await json(['--profile', state.profile, '--json', 'context', '--space', state.config.space]);
      if (value.schemaVersion !== 1 || value.profile !== state.profile || typeof value.sessionDid !== 'string' ||
          !value.sessionDid.startsWith('did:key:') || !['missing', 'expired', 'present', 'unknown-expiry'].includes(value.session?.state)) fail('INVALID_RESPONSE');
      if (host(value.host) !== bound.host || value.sessionDid !== bound.sessionDid) fail('CONTEXT_MISMATCH');
      if (value.ownerDid !== null && !primary(value.ownerDid)) fail('INVALID_RESPONSE');
      if (value.ownerDid && !sameOwner(value.ownerDid, bound.owner)) fail('OWNER_MISMATCH');
      if (value.session.state === 'expired' || value.session.state === 'present' && Date.parse(value.session.expiresAt) <= Date.now()) fail('AUTH_EXPIRED');
      if (value.session.state === 'missing') fail('AUTH_REQUIRED');
      if (value.session.state === 'present' && !Number.isFinite(Date.parse(value.session.expiresAt))) fail('INVALID_RESPONSE');
      if (!primary(value.ownerDid) || value.spaceId !== bound.space) fail('CONTEXT_MISMATCH');
      return { ...bound, session: value.session };
    },
    /** One OpenKey link for TinyChat's reads, when the profile doesn't have them yet. */
    async authorize() {
      const state = await current();
      const context = await inspect(state, { access: true });
      if (context.status !== 'access-required') return context;
      const approvalUrl = await runGrant(grantArgs(state), { executable });
      if (!approvalUrl) return inspect(state, { access: true });
      return { ...context, status: 'awaiting-approval', approvalUrl, message: APPROVAL_MESSAGE,
        next: 'Send the owner approvalUrl with this message. When they send the code, run login with it exactly as sent.' };
    },
    /** Passes the code the owner sent, exactly as sent, to the CLI on stdin. */
    async login(code) {
      const input = responseInput(code);
      const state = await current();
      const context = await inspect(state, { access: true });
      if (context.status !== 'access-required') return context;
      await runGrant(grantArgs(state), { executable, input });
      const verified = await inspect(state, { access: true });
      if (verified.status !== 'ready') fail('INVALID_RESPONSE');
      await save(state);
      return verified;
    },
  };
}
