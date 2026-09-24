#!/usr/bin/env node
/** Package the installed helper and readable sources together; never include local fixtures or credentials. */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, lstat, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' } } });
const source = resolve(values.source ?? join(root, 'agent-skills/tinychat-retrieval'));
const output = resolve(values.output ?? join(root, 'frontend/public/agents'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function filesAt(dir, prefix = '') {
  const files = [];
  for (const entry of (await readdir(dir)).sort()) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const stat = await lstat(join(dir, entry));
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in a release: ${rel}`);
    if (stat.isDirectory()) files.push(...await filesAt(join(dir, entry), rel));
    else if (stat.isFile()) files.push(rel);
    else throw new Error(`Unsupported release entry: ${rel}`);
  }
  return files;
}

async function build() {
  const pack = JSON.parse(await readFile(join(source, 'pack.json'), 'utf8'));
  if (pack.name !== 'tinychat-retrieval' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(pack.version)) {
    throw new Error('Invalid pack name or version');
  }
  const required = ['SKILL.md', 'pack.json', 'scripts/retrieve.mjs', 'scripts/setup.mjs', 'lib/setup.mjs', 'lib/consumer.mjs', 'scripts/consume.mjs', 'lib/session-handoff.mjs', 'lib/evidence.mjs', 'references/session-handoff.md', 'lib/login.mjs', 'lib/approval.mjs', 'lib/opencode-plugin.mjs', 'lib/opencode-activation.mjs', 'lib/opencode-continuation.mjs', 'scripts/install-opencode.mjs', 'references/setup.md', 'references/meetings.md', 'assets/permissions.json'];
  for (const file of required) await readFile(join(source, file));
  const stage = await mkdtemp(join(tmpdir(), 'tinychat-skill-build-'));
  try {
    const pkg = join(stage, 'package');
    await mkdir(pkg);
    const allowed = ['SKILL.md', 'pack.json', 'scripts', 'references', 'assets', 'lib'];
    for (const entry of allowed) {
      const stat = await lstat(join(source, entry)).catch(error => { if (error.code === 'ENOENT' && entry === 'lib') return null; throw error; });
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw new Error(`Symlink source is not allowed: ${entry}`);
      if (stat.isDirectory()) await filesAt(join(source, entry));
      await cp(join(source, entry), join(pkg, entry), { recursive: true });
    }
    await writeFile(join(pkg, 'package.json'), JSON.stringify({
      name: '@tinycloud/tinychat-retrieval', version: pack.version, private: true,
      type: 'module', description: 'TinyChat retrieval skill and portable read helpers',
      engines: { node: '>=20' }, files: allowed,
    }, null, 2) + '\n');
    const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', stage], {
      cwd: pkg, encoding: 'utf8', env: { ...process.env, npm_config_update_notifier: 'false' },
    });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    const info = JSON.parse(packed.stdout)[0];
    const archive = `tinychat-retrieval-${pack.version}.tgz`;
    const bytes = await readFile(join(stage, info.filename));
    const files = {};
    for (const path of await filesAt(pkg)) files[path] = digest(await readFile(join(pkg, path)));
    const release = { schemaVersion: 1, name: pack.name, version: pack.version, archive, sha256: digest(bytes), files };
    const manifest = JSON.stringify(release, null, 2) + '\n';
    const destination = join(output, pack.name, pack.version);
    const previous = await readFile(join(destination, 'release.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const existing = previous === null ? null : JSON.parse(previous);
    if (existing && (existing.schemaVersion !== 1 || existing.name !== pack.name || existing.version !== pack.version || existing.archive !== archive || JSON.stringify(existing.files) !== JSON.stringify(files))) {
      throw new Error(`Version ${pack.version} is immutable. Bump pack.json version before replacing a release.`);
    }
    if (previous === null) {
      const ready = join(stage, 'release');
      await cp(pkg, ready, { recursive: true });
      await writeFile(join(ready, archive), bytes);
      await writeFile(join(ready, 'release.json'), manifest);
      await mkdir(dirname(destination), { recursive: true });
      // Copy into the destination's filesystem, then rename so partially built releases stay hidden.
      const pending = `${destination}.pending-${process.pid}`;
      try {
        await cp(ready, pending, { recursive: true, errorOnExist: true, force: false });
        await rename(pending, destination);
      } finally { await rm(pending, { recursive: true, force: true }); }
    } else {
      for (const [path, hash] of Object.entries(files)) {
        if (digest(await readFile(join(destination, path))) !== hash) throw new Error(`Existing release file differs: ${path}`);
      }
      if (digest(await readFile(join(destination, archive))) !== existing.sha256) throw new Error('Existing archive differs from its release hash');
    }
    process.stdout.write(JSON.stringify({ version: pack.version, archive: join(destination, archive), sha256: existing?.sha256 ?? release.sha256 }) + '\n');
  } finally { await rm(stage, { recursive: true, force: true }); }
}
try { await build(); } catch (error) { console.error(error.message); process.exitCode = 1; }
