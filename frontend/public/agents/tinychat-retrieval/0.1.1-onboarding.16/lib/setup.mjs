import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createTcRunner } from './retrieval.mjs';
import { runLogin, responseInput } from './login.mjs';
import { deliverApproval } from './approval.mjs';

const messages = {
  SETUP_CONFIG_REQUIRED: 'Open the TinyChat setup prompt to supply this deployment’s configuration automatically.',
  SETUP_CONFIG_INVALID: 'TinyChat setup metadata is missing or ambiguous. Correct the app deployment configuration.',
  INVALID_RESPONSE: 'The CLI returned incomplete or conflicting context.',
  CONTEXT_MISMATCH: 'The saved TinyChat setup uses a different profile, host or space. Keep it intact; use prepare --new-profile only for an intentional account or deployment change.',
  OWNER_MISMATCH: 'The selected signing identity differs from the saved or app-supplied identity. Choose the intended key in OpenKey, or use prepare --new-profile for an intentional account change.',
  APPROVAL_CONTEXT_CHANGED: 'The pending approval belongs to a different profile, host or session key. Keep the selected account intact.',
  CLI_VERSION: 'This setup needs TinyCloud CLI 0.10.0 or later.',
};
const fail = code => { throw Object.assign(new Error(messages[code]), { code }); };
const primary = v => typeof v === 'string' && /^did:pkh:eip155:[1-9][0-9]*:0x[a-fA-F0-9]{40}$/.test(v);
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
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

/** App-owned profile selection. The official CLI verifies all authentication responses. */
export function createSetup({ runTc = createTcRunner(), statePath, manifestPath, executable = 'tc' }) {
  async function load() {
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; fail('SETUP_CONFIG_INVALID'); }
    if (state.schemaVersion !== 1 || !/^tinychat-agent(?:-[0-9]+)?$/.test(state.profile) || (state.owner !== undefined && !primary(state.owner))) fail('SETUP_CONFIG_INVALID');
    return { ...state, config: validateConfig(state.config) };
  }
  async function save(state) {
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, statePath);
  }
  async function json(args) {
    const raw = await runTc(args);
    try { return JSON.parse(raw); } catch { fail('INVALID_RESPONSE'); }
  }
  async function inspect(state) {
    const listed = await json(['--json', 'profile', 'list']);
    if (!Array.isArray(listed.profiles)) fail('INVALID_RESPONSE');
    const stored = listed.profiles.find(profile => profile.name === state.profile);
    if (!stored || host(stored.host) !== state.config.host) fail('CONTEXT_MISMATCH');
    const base = ['--profile', state.profile, '--host', state.config.host, '--json', 'context'];
    let value = await json(base);
    function validate() {
      if (value.schemaVersion !== 1 || value.profile !== state.profile || !['missing', 'expired', 'present', 'unknown-expiry'].includes(value.session?.state)) fail('INVALID_RESPONSE');
      if (typeof value.sessionDid !== 'string' || !value.sessionDid.startsWith('did:key:')) fail('INVALID_RESPONSE');
      if (value.session.state === 'present' && (!Number.isFinite(Date.parse(value.session.expiresAt)) || Date.parse(value.session.expiresAt) <= Date.now())) fail('INVALID_RESPONSE');
      if (host(value.host) !== state.config.host) fail('CONTEXT_MISMATCH');
      if (value.ownerDid !== null && !primary(value.ownerDid)) fail('INVALID_RESPONSE');
      for (const expected of [state.owner, state.config.expectedOwner]) {
        if (expected && value.ownerDid && !sameOwner(expected, value.ownerDid)) fail('OWNER_MISMATCH');
      }
    }
    validate();
    const identityMatch = state.config.expectedOwner ? 'app-expected-owner' : 'browser-selection-only';
    const common = { schemaVersion: 1, profile: state.profile, host: state.config.host, sessionDid: value.sessionDid, identityMatch, access: 'not-tested' };
    if (['missing', 'expired'].includes(value.session.state)) {
      const expected = state.owner ?? state.config.expectedOwner ?? value.ownerDid;
      const loginArgs = ['--profile', state.profile, '--host', state.config.host, 'auth', 'login', '--method', 'openkey', '--manifest', manifestPath, '--expiry', '7d', ...(expected ? ['--owner', expected] : [])];
      return { ...common, status: 'login-required', reason: value.session.state, loginArgs, loginCommand: [executable, ...loginArgs].map(shellQuote).join(' ') };
    }
    if (!primary(value.ownerDid)) fail('INVALID_RESPONSE');
    const first = value;
    value = await json([...base, '--space', state.config.space]);
    validate();
    if (!primary(value.ownerDid) || !['present', 'unknown-expiry'].includes(value.session.state)) fail('INVALID_RESPONSE');
    if (!sameOwner(value.ownerDid, first.ownerDid) || value.sessionDid !== first.sessionDid) fail('CONTEXT_MISMATCH');
    const expectedSpace = `tinycloud:${value.ownerDid.slice(4)}:${state.config.space}`;
    if (typeof value.spaceId !== 'string' || value.spaceId.toLowerCase() !== expectedSpace.toLowerCase() || !value.spaceId.endsWith(`:${state.config.space}`)) fail('CONTEXT_MISMATCH');
    if (!state.owner) { state.owner = value.ownerDid; await save(state); }
    const retrievalArgs = ['--profile', state.profile, '--host', state.config.host, '--space', value.spaceId, '--owner', value.ownerDid];
    return { ...common, status: 'ready', owner: value.ownerDid, space: value.spaceId, session: value.session, retrievalArgs };
  }
  return {
    async prepare({ config: supplied, newProfile = false } = {}) {
      let state = await load();
      const config = supplied === undefined ? state?.config : validateConfig(supplied);
      if (!config) fail('SETUP_CONFIG_REQUIRED');
      if (state && !newProfile) {
        if (config.host !== state.config.host || config.space !== state.config.space) fail('CONTEXT_MISMATCH');
        if (config.expectedOwner && [state.owner, state.config.expectedOwner].some(owner => owner && !sameOwner(owner, config.expectedOwner))) fail('OWNER_MISMATCH');
        // A generic public prompt must not erase an earlier app identity check.
        if (config.expectedOwner) state.config.expectedOwner = config.expectedOwner;
      }
      const version = (await runTc(['--version'])).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
      if (!version || (Number(version[1]) === 0 && Number(version[2]) < 10)) fail('CLI_VERSION');
      if (!state || newProfile) {
        const listed = await json(['--json', 'profile', 'list']);
        if (!Array.isArray(listed.profiles) || listed.profiles.some(p => typeof p.name !== 'string')) fail('INVALID_RESPONSE');
        const names = new Set(listed.profiles.map(p => p.name));
        let profile = 'tinychat-agent';
        for (let index = 2; names.has(profile); index++) profile = `tinychat-agent-${index}`;
        // profile create does not replace keys or change the CLI's default profile.
        await json(['--json', 'profile', 'create', profile, '--host', config.host]);
        state = { schemaVersion: 1, profile, config };
        await save(state);
      }
      const result = await inspect(state);
      await save(state);
      return result;
    },
    async context() {
      const state = await load();
      if (!state) fail('SETUP_CONFIG_REQUIRED');
      return inspect(state);
    },
    async guard(bound) {
      const state = await load();
      if (!state) fail('SETUP_CONFIG_REQUIRED');
      if (!bound || bound.profile !== state.profile || bound.host !== state.config.host ||
          !bound.space?.endsWith(`:${state.config.space}`) ||
          [state.owner, state.config.expectedOwner].some(owner => owner && !sameOwner(owner, bound.owner))) fail('CONTEXT_MISMATCH');
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
    async authorize({ delivery = 'browser' } = {}) {
      const state = await load();
      if (!state) fail('SETUP_CONFIG_REQUIRED');
      const context = await inspect(state);
      if (context.status === 'ready') return context;
      const authorizationUrl = await runLogin(context.loginArgs, { executable });
      return { ...context, status: 'awaiting-approval', delivery: await deliverApproval(authorizationUrl, { mode: delivery }) };
    },
    async login(code, { expectedContext } = {}) {
      const input = responseInput(code);
      const state = await load();
      if (!state) fail('SETUP_CONFIG_REQUIRED');
      const context = await inspect(state);
      if (expectedContext && ['profile', 'host', 'sessionDid', 'loginArgs'].some(key => JSON.stringify(context[key]) !== JSON.stringify(expectedContext[key]))) fail('APPROVAL_CONTEXT_CHANGED');
      if (context.status === 'ready') return context;
      await runLogin(context.loginArgs, { executable, input });
      const verified = await inspect(state);
      if (verified.status !== 'ready') fail('INVALID_RESPONSE');
      return verified;
    },
  };
}
