import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const builder = new URL('../build-agent-skills.mjs', import.meta.url);
const root = new URL('../../', import.meta.url);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tinychat-pack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'tinychat-retrieval');
  for (const sub of ['scripts', 'references', 'assets', 'tests']) await mkdir(join(source, sub), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: tinychat-retrieval\ndescription: Read TinyChat meetings.\n---\nRead references/meetings.md and run scripts/retrieve.mjs.\n');
  await writeFile(join(source, 'pack.json'), JSON.stringify({ name: 'tinychat-retrieval', version: '0.1.0', envelopeVersion: 1 }));
  await writeFile(join(source, 'scripts/retrieve.mjs'), "console.log('fixture helper')\n");
  await writeFile(join(source, 'references/meetings.md'), 'Meeting read reference.');
  await writeFile(join(source, 'assets/permissions.json'), '{"defaults":false,"permissions":[]}');
  await writeFile(join(source, '.env'), 'SECRET_MUST_NOT_SHIP');
  await writeFile(join(source, 'tests/private.json'), 'PRIVATE_MUST_NOT_SHIP');
  return { dir, source, output: join(dir, 'public') };
}
function build(source, output) {
  return spawnSync(process.execPath, [builder.pathname, '--source', source, '--output', output], { encoding: 'utf8' });
}
test('builds a complete portable archive and same-source readable release with verified hashes', async t => {
  const { source, output, dir } = await fixture(t);
  const result = build(source, output);
  assert.equal(result.status, 0, result.stderr);
  const release = join(output, 'tinychat-retrieval/0.1.0');
  const manifest = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'));
  assert.equal(manifest.version, '0.1.0');
  const archive = await readFile(join(release, manifest.archive));
  assert.equal(createHash('sha256').update(archive).digest('hex'), manifest.sha256);
  const listing = spawnSync('tar', ['-tzf', join(release, manifest.archive)], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  for (const item of ['SKILL.md', 'pack.json', 'scripts/retrieve.mjs', 'assets/permissions.json', 'references/meetings.md']) {
    assert.ok(listing.stdout.includes(item), `archive missing ${item}`);
    assert.equal(await readFile(join(release, item), 'utf8'), await readFile(join(source, item), 'utf8'));
  }
  assert.ok(!listing.stdout.includes('.env'));
  assert.ok(!listing.stdout.includes('tests/'));
  const unpacked = join(dir, 'unpacked');
  await mkdir(unpacked);
  assert.equal(spawnSync('tar', ['-xzf', join(release, manifest.archive), '-C', unpacked]).status, 0);
  const execution = spawnSync(process.execPath, [join(unpacked, 'package/scripts/retrieve.mjs')], { encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout.trim(), 'fixture helper');
  assert.equal(build(source, output).status, 0, 'identical rebuild is idempotent');
  assert.equal(await readFile(join(release, 'release.json'), 'utf8'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(source, 'scripts/retrieve.mjs'), 'changed\n');
  const changed = build(source, output);
  assert.notEqual(changed.status, 0, 'a published version cannot be silently replaced');
  assert.match(changed.stderr, /version|immutable/i);
});
test('rejects invalid versions and missing runtime files without producing a release', async t => {
  const { source, output } = await fixture(t);
  await writeFile(join(source, 'pack.json'), '{"name":"tinychat-retrieval","version":"../escape"}');
  assert.notEqual(build(source, output).status, 0);
  assert.deepEqual(await readdir(output).catch(() => []), []);
  await writeFile(join(source, 'pack.json'), '{"name":"tinychat-retrieval","version":"0.1.0"}');
  await rm(join(source, 'assets/permissions.json'));
  assert.notEqual(build(source, output).status, 0);
});
test('reuses a verified immutable archive when packer gzip metadata differs but sources match', async t => {
  const { source, output } = await fixture(t);
  assert.equal(build(source, output).status, 0);
  const release = join(output, 'tinychat-retrieval/0.1.0');
  const receiptPath = join(release, 'release.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const archivePath = join(release, receipt.archive);
  const archive = await readFile(archivePath);
  archive[4] = 42; // gzip mtime is not source content; tar payload is unchanged.
  receipt.sha256 = createHash('sha256').update(archive).digest('hex');
  await writeFile(archivePath, archive);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  const rebuilt = build(source, output);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(JSON.parse(rebuilt.stdout).sha256, receipt.sha256);
  assert.deepEqual(await readFile(archivePath), archive, 'existing identified release bytes stay exact');
});
