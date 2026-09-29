import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFESTS = [
  'package.json',
  'packages/core/package.json',
  'packages/client/package.json',
  'packages/server/package.json',
  'frontend/package.json',
  'backend/package.json',
  'test/package.json',
  'desktop/package.json',
  'desktop/src-tauri/tauri.conf.json',
  'desktop/src-tauri/Cargo.toml',
  'desktop/src-tauri/Cargo.lock',
  '.changeset/config.json',
  '.changeset/README.md',
];

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tinychat-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

function editJson(root, rel, edit) {
  const value = JSON.parse(read(root, rel));
  edit(value);
  write(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

function run(name, args = []) {
  return spawnSync(process.execPath, [join(repo, 'scripts/release', name), ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(root) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Release Test');
  git(root, 'config', 'user.email', 'release-test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'tag.gpgsign', 'false');
}

function commitAll(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

// A copy of this repo's real manifests and desktop version files.
function manifests(t) {
  const root = tempDir(t);
  for (const rel of MANIFESTS) write(root, rel, read(repo, rel));
  return root;
}

const check = (root, ...args) => run('check.mjs', ['--root', root, ...args]);

test('the repository satisfies the release invariants', () => {
  const result = run('check.mjs');
  assert.equal(result.status, 0, result.stderr);
});

test('check passes on a copy of the real manifests', t => {
  const result = check(manifests(t));
  assert.equal(result.status, 0, result.stderr);
});

test('a release unit without a version fails (Changesets would silently skip it)', t => {
  const root = manifests(t);
  editJson(root, 'backend/package.json', pkg => delete pkg.version);
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backend\/package\.json needs a stable X\.Y\.Z "version"/);
});

test('a prerelease version fails (stable only)', t => {
  const root = manifests(t);
  editJson(root, 'frontend/package.json', pkg => { pkg.version = '0.2.0-beta.1'; });
  assert.match(check(root).stderr, /frontend\/package\.json needs a stable X\.Y\.Z "version"/);
});

test('a workspace package that is not private fails', t => {
  const root = manifests(t);
  editJson(root, 'packages/core/package.json', pkg => delete pkg.private);
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/core\/package\.json \(@tinyboilerplate\/core\) must be "private": true/);
});

test('a changeset naming a library or a mix of library and unit fails', t => {
  const root = manifests(t);
  write(root, '.changeset/mixed.md', '---\n"@tinychat/backend": patch\n"@tinyboilerplate/core": patch\n---\n\nFix.\n');
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.changeset\/mixed\.md names @tinyboilerplate\/core/);
  assert.doesNotMatch(result.stderr, /names @tinychat\/backend/);
});

test('empty changesets and changesets naming units pass', t => {
  const root = manifests(t);
  write(root, '.changeset/empty.md', '---\n---\n');
  write(root, '.changeset/units.md', "---\n'exo-desktop': minor\n\"@tinychat/frontend\": patch\n---\n\nShip it.\n");
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

test('prerelease mode fails', t => {
  const root = manifests(t);
  write(root, '.changeset/pre.json', '{"mode":"pre","tag":"beta","initialVersions":{},"changesets":[]}\n');
  assert.match(check(root).stderr, /prerelease mode is not allowed/);
});

test('tauri.conf.json must read its version from desktop/package.json', t => {
  const root = manifests(t);
  editJson(root, 'desktop/src-tauri/tauri.conf.json', conf => { conf.version = '0.1.0'; });
  assert.match(check(root).stderr, /tauri\.conf\.json "version" must be "\.\.\/package\.json"/);
});

test('desktop version drift fails, and the sync script fixes exactly the exo-desktop entries', t => {
  const root = manifests(t);
  const lockBefore = read(root, 'desktop/src-tauri/Cargo.lock');
  const tomlBefore = read(root, 'desktop/src-tauri/Cargo.toml');
  editJson(root, 'desktop/package.json', pkg => { pkg.version = '0.2.0'; });

  const drift = check(root);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /Cargo\.toml has exo-desktop 0\.1\.0 but desktop\/package\.json has 0\.2\.0/);
  assert.match(drift.stderr, /Cargo\.lock has exo-desktop 0\.1\.0 but desktop\/package\.json has 0\.2\.0/);

  const sync = run('sync-desktop-version.mjs', ['--root', root]);
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(check(root).status, 0);

  const lockAfter = read(root, 'desktop/src-tauri/Cargo.lock');
  assert.equal(lockAfter, lockBefore.replace('name = "exo-desktop"\nversion = "0.1.0"', 'name = "exo-desktop"\nversion = "0.2.0"'));
  assert.notEqual(lockAfter, lockBefore);
  assert.equal(read(root, 'desktop/src-tauri/Cargo.toml'), tomlBefore.replace(/^version = "0\.1\.0"$/m, 'version = "0.2.0"'));

  const again = run('sync-desktop-version.mjs', ['--root', root]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, '');
});

test('--since requires the branch to add a changeset and nudges desktop for frontend changes', t => {
  const root = manifests(t);
  initRepo(root);
  commitAll(root, 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'frontend/src/app.ts', 'export {};\n');
  commitAll(root, 'frontend change');

  const missing = check(root, '--since', 'main');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No changeset added since main/);

  write(root, '.changeset/web.md', '---\n"@tinychat/frontend": patch\n---\n\nWeb fix.\n');
  commitAll(root, 'changeset');
  const nudged = check(root, '--since', 'main');
  assert.equal(nudged.status, 0, nudged.stderr);
  assert.match(nudged.stdout, /frontend\/src changed without an exo-desktop changeset/);

  write(root, '.changeset/desktop.md', '---\n"exo-desktop": patch\n---\n\nShip the web fix in Exo.\n');
  commitAll(root, 'desktop changeset');
  const clean = check(root, '--since', 'main');
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout, /without an exo-desktop changeset/);
});

test('--since accepts an empty changeset as the opt-out', t => {
  const root = manifests(t);
  initRepo(root);
  commitAll(root, 'base');
  git(root, 'checkout', '-q', '-b', 'docs');
  write(root, 'docs/notes.md', 'notes\n');
  write(root, '.changeset/quiet-docs.md', '---\n---\n');
  commitAll(root, 'docs only');
  const result = check(root, '--since', 'main');
  assert.equal(result.status, 0, result.stderr);
});

// tag.mjs: a scratch repo with a bare "origin", exercising root, merge and squash commits.
function tagRepo(t) {
  const dir = tempDir(t);
  const origin = join(dir, 'origin.git');
  const root = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', origin);
  mkdirSync(root);
  initRepo(root);
  git(root, 'remote', 'add', 'origin', origin);
  for (const [dir, name] of [['desktop', 'exo-desktop'], ['frontend', '@tinychat/frontend'], ['backend', '@tinychat/backend']]) {
    write(root, `${dir}/package.json`, `${JSON.stringify({ name, version: '0.1.0', private: true }, null, 2)}\n`);
  }
  return { root, origin };
}

const tag = root => run('tag.mjs', ['--root', root]);
const tagCommit = (cwd, name) => git(cwd, 'rev-parse', `refs/tags/${name}^{commit}`);

test('tag.mjs tags the commit that set each version, across root, merge and squash commits', t => {
  const { root, origin } = tagRepo(t);
  const baseline = commitAll(root, 'baseline versions');
  write(root, 'README.md', 'later work\n');
  commitAll(root, 'unrelated later commit');

  const first = tag(root);
  assert.equal(first.status, 0, first.stderr);
  for (const name of ['exo-desktop@0.1.0', '@tinychat/frontend@0.1.0', '@tinychat/backend@0.1.0']) {
    assert.equal(tagCommit(root, name), baseline);
    assert.equal(tagCommit(origin, name), baseline);
  }
  assert.equal(git(root, 'cat-file', '-t', 'refs/tags/exo-desktop@0.1.0'), 'tag');

  // Version PR merged with a merge commit, followed by more main commits that touch the same file.
  git(root, 'checkout', '-q', '-b', 'changeset-release/main');
  editJson(root, 'desktop/package.json', pkg => { pkg.version = '0.2.0'; });
  commitAll(root, 'chore(release): version packages');
  git(root, 'checkout', '-q', 'main');
  write(root, 'backend/src.ts', 'export {};\n');
  commitAll(root, 'feature on main meanwhile');
  git(root, 'merge', '-q', '--no-ff', '-m', 'Merge version packages', 'changeset-release/main');
  const merge = git(root, 'rev-parse', 'HEAD');
  editJson(root, 'desktop/package.json', pkg => { pkg.scripts = { dev: 'tauri dev' }; });
  commitAll(root, 'later desktop/package.json edit');

  // Version PR squash-merged, then another edit to the same package.json.
  editJson(root, 'frontend/package.json', pkg => { pkg.version = '0.1.1'; });
  const squash = commitAll(root, 'chore(release): version packages (#2)');
  editJson(root, 'frontend/package.json', pkg => { pkg.dependencies = { react: '^19' }; });
  commitAll(root, 'later frontend/package.json edit');

  const second = tag(root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(tagCommit(root, 'exo-desktop@0.2.0'), merge);
  assert.equal(tagCommit(origin, 'exo-desktop@0.2.0'), merge);
  assert.equal(tagCommit(root, '@tinychat/frontend@0.1.1'), squash);
  assert.equal(tagCommit(origin, '@tinychat/frontend@0.1.1'), squash);
  assert.match(second.stdout, /@tinychat\/backend@0\.1\.0 already tagged/);

  const third = tag(root);
  assert.equal(third.status, 0, third.stderr);
  assert.doesNotMatch(third.stdout, /tagged exo|tagged @|pushed/);
});

test('tag.mjs fails loudly when an existing tag points at the wrong commit', t => {
  const { root } = tagRepo(t);
  commitAll(root, 'baseline versions');
  write(root, 'README.md', 'later\n');
  const later = commitAll(root, 'later');
  git(root, 'tag', '-a', '@tinychat/backend@0.1.0', '-m', 'wrong', later);
  const result = tag(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tag @tinychat\/backend@0\.1\.0 points at/);
});
