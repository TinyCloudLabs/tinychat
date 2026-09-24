import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { activationRoot, prepareActivation, writeActivation } from '../lib/opencode-activation.mjs';

const nonce = 'ab'.repeat(32);
const epoch = 1780000000000;
const executable = '/opt/homebrew/Cellar/opencode/1.18.31/bin/opencode';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tinychat-activation-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'project');
  const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), OPENCODE: '1', OPENCODE_PID: '123' };
  await mkdir(directory);
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true });
  const dbPath = join(env.XDG_DATA_HOME, 'opencode/opencode.db');
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_updated INTEGER, data TEXT)');
  function insert({ id = 'one', dir = directory, output = '', status = 'running', completed = false, tool = 'bash' } = {}) {
    db.prepare('INSERT INTO session VALUES (?, ?)').run(`ses_${id}`, dir);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(`msg_user${id}`, `ses_${id}`, epoch - 20, JSON.stringify({ role: 'user', time: { created: epoch - 20 } }));
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(`msg_${id}`, `ses_${id}`, epoch - 10, JSON.stringify({ role: 'assistant', parentID: `msg_user${id}`, agent: 'build', providerID: 'openai', modelID: 'gpt-5.6-luna', time: { created: epoch - 10, ...(completed ? { completed: epoch } : {}) } }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(`prt_${id}`, `msg_${id}`, `ses_${id}`, epoch, JSON.stringify({ type: 'tool', tool, state: { status, metadata: { output } } }));
  }
  insert();
  const markers = [];
  const options = {
    env, directory, platform: 'darwin', nodeVersion: '25.6.1', parentPID: 456, nonce,
    now: () => epoch, timeoutMs: 0,
    processInfo: async pid => pid === 456 ? { parentPID: 123 } : { parentPID: 1, executable, args: `${executable} ${directory} --model openai/gpt-5.6-luna` },
    getVersion: async () => '1.18.31',
    emitMarker: async marker => {
      markers.push(marker);
      db.prepare("UPDATE part SET data = json_set(data, '$.state.metadata.output', ?) WHERE id = 'prt_one'").run(marker + '\n');
    },
  };
  return { root, directory, env, db, dbPath, insert, options, markers };
}

test('binds only its streamed native tool marker and preserves original session, parent, model and agent', async t => {
  const f = await fixture(t);
  f.insert({ id: 'old', output: 'unrelated private content', status: 'completed', completed: true });
  let afterHostWrite;
  const descriptor = await prepareActivation({ ...f.options, integrationVersion: '0.1.1-onboarding.15', emitMarker: async marker => {
    await f.options.emitMarker(marker);
    afterHostWrite = await readFile(f.dbPath);
  } });
  assert.deepEqual(descriptor, {
    schemaVersion: 1, nonce, marker: `TINYCHAT_ACTIVATION:${nonce}`, sessionID: 'ses_one', messageID: 'msg_one',
    partID: 'prt_one', userMessageID: 'msg_userone', agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
    directory: f.directory, hostPID: 123, createdAt: epoch, expiresAt: epoch + 120000, integrationVersion: '0.1.1-onboarding.15',
  });
  assert.deepEqual(f.markers, [`TINYCHAT_ACTIVATION:${nonce}`]);
  assert.doesNotMatch(JSON.stringify(descriptor), /unrelated private content/);
  assert.deepEqual(await readFile(f.dbPath), afterHostWrite, 'binding must not modify the database');
  await assert.rejects(stat(activationRoot(f.env)), { code: 'ENOENT' });
});

test('publishes a private one-time descriptor atomically without overwriting an existing attempt', async t => {
  const f = await fixture(t);
  const descriptor = await prepareActivation(f.options);
  const path = await writeActivation(descriptor, { env: f.env, now: () => epoch });
  assert.equal(path, join(activationRoot(f.env), '123.json'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(activationRoot(f.env))).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), descriptor);
  await assert.rejects(writeActivation(descriptor, { env: f.env, now: () => epoch }), { code: 'OPENCODE_ACTIVATION_PENDING' });
  assert.deepEqual(await readdir(activationRoot(f.env)), ['123.json']);
});

test('preserves a nonempty original model variant and rejects invalid descriptor variants', async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE message SET data=json_set(data, '$.variant', 'high') WHERE id='msg_one'").run();
  const descriptor = await prepareActivation(f.options);
  assert.equal(descriptor.variant, 'high');
  await assert.rejects(writeActivation({ ...descriptor, variant: 7 }, { env: f.env, now: () => epoch }), { code: 'OPENCODE_ACTIVATION_INVALID' });
  await assert.rejects(writeActivation({ ...descriptor, variant: '' }, { env: f.env, now: () => epoch }), { code: 'OPENCODE_ACTIVATION_INVALID' });
  f.db.prepare("UPDATE message SET data=json_set(data, '$.variant', '') WHERE id='msg_one'").run();
  assert.equal(Object.hasOwn(await prepareActivation(f.options), 'variant'), false);
});

test('rejects invalid or stale descriptors and a symlinked activation directory', async t => {
  const f = await fixture(t);
  const descriptor = await prepareActivation(f.options);
  await assert.rejects(writeActivation({ ...descriptor, sessionID: '' }, { env: f.env, now: () => epoch }), { code: 'OPENCODE_ACTIVATION_INVALID' });
  await assert.rejects(writeActivation(descriptor, { env: f.env, now: () => epoch + 120001 }), { code: 'OPENCODE_ACTIVATION_INVALID' });
  await mkdir(join(f.env.XDG_STATE_HOME, 'tinychat-retrieval'), { recursive: true });
  await symlink(f.directory, activationRoot(f.env));
  await assert.rejects(writeActivation(descriptor, { env: f.env, now: () => epoch }), { code: 'OPENCODE_ACTIVATION_INVALID' });
});

test('rejects unsupported platforms, runtimes, custom databases and malformed process markers before output', async t => {
  const f = await fixture(t);
  for (const changes of [
    { platform: 'linux' }, { nodeVersion: '22.19.0' }, { nonce: 'bad' },
    { env: { ...f.env, OPENCODE: '' } }, { env: { ...f.env, OPENCODE_PID: '-1' } },
    { env: { ...f.env, OPENCODE_DB: ':memory:' } }, { env: { ...f.env, XDG_DATA_HOME: 'relative' } },
    { getVersion: async () => '1.18.32' },
  ]) await assert.rejects(prepareActivation({ ...f.options, ...changes }));
  assert.equal(f.markers.length, 0);
});

test('rejects nonancestor and non-TUI hosts without emitting a marker', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareActivation({ ...f.options, processInfo: async () => ({ parentPID: 1 }) }));
  for (const args of ['serve', 'run hello', 'attach http://localhost:4096', '--mini', '--unknown', 'plugin pkg', `${f.directory} extra-project`, `${f.directory} --prompt hello`, `${f.directory} --mini=true`]) {
    await assert.rejects(prepareActivation({ ...f.options, parentPID: 123, processInfo: async () => ({ parentPID: 1, executable, args: `${executable} ${args}` }) }));
  }
  assert.equal(f.markers.length, 0);
});

test('accepts the direct default TUI and rejects a symlinked database', async t => {
  const f = await fixture(t);
  await prepareActivation({ ...f.options, parentPID: 123, processInfo: async () => ({ parentPID: 1, executable, args: executable }) });
  await rename(f.dbPath, f.dbPath + '.real');
  await symlink(f.dbPath + '.real', f.dbPath);
  await assert.rejects(prepareActivation(f.options), { code: 'OPENCODE_ACTIVATION_INVALID' });
});

test('rejects absent and ambiguous markers instead of guessing a session', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareActivation({ ...f.options, emitMarker: () => {} }), { code: 'OPENCODE_ACTIVATION_SESSION_NOT_FOUND' });
  f.insert({ id: 'two', output: `TINYCHAT_ACTIVATION:${nonce}` });
  await assert.rejects(prepareActivation(f.options), { code: 'OPENCODE_ACTIVATION_SESSION_AMBIGUOUS' });
});

test('rejects other unfinished assistants and tools conservatively, even in other directories', async t => {
  const f = await fixture(t);
  f.insert({ id: 'other', dir: join(f.root, 'elsewhere'), status: 'completed' });
  await assert.rejects(prepareActivation(f.options), { code: 'OPENCODE_ACTIVATION_CONCURRENT_WORK' });
  f.db.prepare("UPDATE message SET data=json_set(data, '$.time.completed', ?) WHERE id='msg_other'").run(epoch);
  f.db.prepare("UPDATE part SET data=json_set(data, '$.state.status', 'running') WHERE id='prt_other'").run();
  await assert.rejects(prepareActivation(f.options), { code: 'OPENCODE_ACTIVATION_CONCURRENT_WORK' });
});

test('refuses marker matches from the wrong directory or non-native tool nesting', async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE part SET data=json_set(data, '$.tool', 'execute')").run();
  await assert.rejects(prepareActivation(f.options), { code: 'OPENCODE_ACTIVATION_SESSION_NOT_FOUND' });
  f.db.prepare("UPDATE part SET data=json_set(data, '$.tool', 'bash')").run();
  f.db.prepare('UPDATE session SET directory=?').run(join(f.root, 'other'));
  await assert.rejects(prepareActivation(f.options), { code: 'OPENCODE_ACTIVATION_SESSION_NOT_FOUND' });
});
