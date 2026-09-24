import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const entry = new URL('../scripts/setup.mjs', import.meta.url);

async function fixture(t, opencode) {
  const root = await mkdtemp(join(tmpdir(), 'tinychat-cold-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const calls = join(root, 'tc-called');
  await mkdir(bin);
  await writeFile(join(bin, 'tc'), '#!/bin/sh\nprintf called >> "$TC_TEST_CALLS"\nexit 73\n', { mode: 0o700 });
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), PATH: bin, TC_TEST_CALLS: calls, ...(opencode === undefined ? {} : { OPENCODE: opencode }) };
  return {
    run: args => spawnSync(process.execPath, [entry.pathname, ...args], { env, encoding: 'utf8' }),
    noTc: () => assert.rejects(readFile(calls), { code: 'ENOENT' }),
  };
}

test('OpenCode shell cannot start portable setup or expose an unbound authorization path', async t => {
  const { run, noTc } = await fixture(t, '1');
  for (const args of [['prepare'], ['context'], ['authorize'], ['authorize', '--delivery', 'file'], ['login', '--code-file', '/nonexistent/response.json']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error.code, 'OPENCODE_TOOLS_REQUIRED', args.join(' '));
    assert.match(output.error.message, /tinychat_setup/);
    assert.match(output.error.message, /tinychat_authorize/);
    assert.match(output.error.message, /install-opencode\.mjs --activate/);
    assert.match(output.error.message, /separate native bash call/);
    assert.match(output.error.message, /automatically/);
    assert.match(output.error.message, /Stop on a classified activation error/);
    assert.doesNotMatch(output.error.message, /then restart OpenCode/);
    assert.equal(output.loginCommand, undefined);
    assert.equal(output.loginArgs, undefined);
    assert.equal(output.delivery, undefined);
  }
  await noTc();
});

test('portable setup remains available outside OpenCode and help remains readable inside it', async t => {
  for (const marker of [undefined, '0']) {
    const { run, noTc } = await fixture(t, marker);
    const result = run(['prepare']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'SETUP_CONFIG_REQUIRED');
    await noTc();
  }
  const { run, noTc } = await fixture(t, '1');
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /tinychat_authorize/);
  assert.match(help.stdout, /install-opencode\.mjs --activate/);
  await noTc();
});
