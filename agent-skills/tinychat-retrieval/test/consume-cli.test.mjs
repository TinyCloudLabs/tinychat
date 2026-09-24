import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const entry = new URL('../scripts/consume.mjs', import.meta.url);

test('portable CLI describes explicit chunks and direct citations without receipt or review commands', () => {
  const result = spawnSync(process.execPath, [entry.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /next: --chunk N/);
  assert.match(result.stdout, /Cite.*ref/);
  assert.ok(!/acknowledge|display-bytes|reviews|review:/i.test(result.stdout));
});

for (const option of ['acknowledge', 'display-bytes', 'reviews', 'claim', 'spans', 'speaker']) {
  test(`portable CLI rejects retired --${option} before setup`, () => {
    const result = spawnSync(process.execPath, [entry.pathname, '--help', `--${option}`, 'unused'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_INPUT');
  });
}
