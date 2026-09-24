import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const entry = new URL('../scripts/install-opencode.mjs', import.meta.url);

test('activation outside a supported OpenCode tool fails before publishing a loader', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tinychat-activation-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [['--activate'], ['--unknown']]) {
    const result = spawnSync(process.execPath, [entry.pathname, ...args], { encoding: 'utf8', env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), OPENCODE: '', OPENCODE_PID: '' } });
    assert.notEqual(result.status, 0, 'unsupported activation must never look successful');
    assert.equal(JSON.parse(result.stdout).ok, false);
    await assert.rejects(access(join(root, 'config/opencode/plugins/tinychat-signin.js')), { code: 'ENOENT' });
  }
});

test('shipped installer installs an idempotent discoverable plugin without changing provider settings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tinychat-install-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'custom-config', 'opencode');
  await mkdir(config, { recursive: true });
  const settings = '{"model":"openai/gpt-5.6-luna"}\n';
  await writeFile(join(config, 'opencode.json'), settings);
  const run = () => spawnSync(process.execPath, [entry.pathname], { encoding: 'utf8', env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'custom-config') } });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.restartRequired, true);
  assert.equal(receipt.opencodeVersion, '1.18.31');
  const path = join(config, 'plugins/tinychat-signin.js');
  const wrapper = await readFile(path, 'utf8');
  assert.match(wrapper, /import TinyChat from "file:\/\//);
  assert.match(wrapper, /import \{ tool \} from "@opencode-ai\/plugin"/);
  assert.match(wrapper, /schema: tool.schema/);
  assert.match(wrapper, /lib\/opencode-plugin.mjs/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(join(config, 'opencode.json'), 'utf8'), settings);
  assert.equal(run().status, 0);
  assert.equal(await readFile(path, 'utf8'), wrapper);
  await writeFile(path, 'unrelated existing plugin');
  assert.notEqual(run().status, 0);
  assert.equal(await readFile(path, 'utf8'), 'unrelated existing plugin');
});
