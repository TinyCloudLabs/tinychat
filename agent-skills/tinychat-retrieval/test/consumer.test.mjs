import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/consume.mjs', import.meta.url));

test('portable consumer documents numbered continuation and direct references', async () => {
  const { stdout } = await exec('node', [script, '--help']);
  assert.match(stdout, /latest:.*select, acquire once and return evidence/);
  assert.match(stdout, /next:.*--chunk/);
  assert.match(stdout, /final evidence needs no additional call/);
  assert.ok(!stdout.includes('--display-bytes'));
});

test('portable consumer rejects duplicate flags and opaque model-supplied references before setup', async () => {
  for (const options of [['--operation', 'second'], ['--ref', 'opaque'], ['--cursor', 'opaque'], ['--reviews', '{invalid']]) {
    const failure = await exec('node', [script, 'latest', '--operation', 'one', '--session', 'synthetic', ...options]).then(() => null, error => error);
    assert.equal(failure?.code, 1);
    assert.equal(JSON.parse(failure.stdout).error.code, 'INVALID_INPUT');
    assert.equal(failure.stderr, '');
  }
});
