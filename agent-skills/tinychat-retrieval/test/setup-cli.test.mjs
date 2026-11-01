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

test('without the TinyCloud CLI, every command says to run onboarding and never runs tc, in or outside OpenCode', async t => {
  for (const marker of [undefined, '0', '1']) {
    const { run, noTc } = await fixture(t, marker);
    for (const args of [['prepare'], ['context'], ['authorize'], ['login', '--code', 'ABCD-EFGH']]) {
      const result = run(args);
      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.error.code, 'CLI_UNAVAILABLE', args.join(' '));
      assert.match(output.error.message, /agents\.tinycloud\.xyz\/onboarding/);
    }
    await noTc();
  }
});

test('help describes the onboarding profile and the pasted code', async t => {
  const { run, noTc } = await fixture(t, '1');
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /onboarding profile/);
  assert.match(help.stdout, /login --code CODE/);
  assert.match(help.stdout, /exactly as sent/);
  assert.doesNotMatch(help.stdout, /code-file|never transcribe|private file/i);
  await noTc();
});
