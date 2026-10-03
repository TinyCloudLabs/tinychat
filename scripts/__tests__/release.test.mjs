import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogSection, classifyPagesCheckRuns, desktopBundleVersions, planDispatches, setCargoLockVersion, setCargoTomlVersion } from '../release/lib.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFESTS = [
  'package.json',
  'bun.lock', // Changesets only detects the bun workspace when the lockfile is present
  'packages/core/package.json',
  'packages/client/package.json',
  'packages/server/package.json',
  'frontend/package.json',
  'backend/package.json',
  'test/package.json',
  'desktop/package.json',
  'mobile/package.json',
  'desktop/src-tauri/tauri.conf.json',
  'desktop/src-tauri/Cargo.toml',
  'desktop/src-tauri/Cargo.lock',
  '.changeset/config.json',
  '.changeset/pre.json',
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
const version = (root, dir) => JSON.parse(read(root, `${dir}/package.json`)).version;

function editJson(root, rel, edit) {
  const value = JSON.parse(read(root, rel));
  edit(value);
  write(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

function run(name, args = [], env = {}) {
  return spawnSync(process.execPath, [join(repo, 'scripts/release', name), ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', ALLOW_MAJOR_BETA: '', ...env },
  });
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

// A copy of this repo's real manifests, Changesets state and desktop version files.
// Normalized to the 0.1.0 baseline in beta pre mode, so tests don't depend on the versions main is at right now.
function manifests(t) {
  const root = tempDir(t);
  for (const rel of MANIFESTS) write(root, rel, read(repo, rel));
  for (const dir of ['desktop', 'frontend', 'backend']) editJson(root, `${dir}/package.json`, pkg => { pkg.version = '0.1.0'; });
  write(root, 'desktop/src-tauri/Cargo.toml', setCargoTomlVersion(read(root, 'desktop/src-tauri/Cargo.toml'), '0.1.0'));
  write(root, 'desktop/src-tauri/Cargo.lock', setCargoLockVersion(read(root, 'desktop/src-tauri/Cargo.lock'), '0.1.0'));
  write(root, '.changeset/pre.json', '{\n  "mode": "pre",\n  "tag": "beta"\n}\n');
  return root;
}

const check = (root, ...args) => run('check.mjs', ['--root', root, ...args]);
const changesetFile = (releases, summary = 'Change.') => `---\n${Object.entries(releases).map(([name, type]) => `"${name}": ${type}`).join('\n')}\n---\n\n${summary}\n`;

test('the repository satisfies the release invariants', () => {
  const result = run('check.mjs');
  assert.equal(result.status, 0, result.stderr);
});

test('check passes on a copy of the real manifests, which start in beta pre mode', t => {
  const root = manifests(t);
  assert.deepEqual(JSON.parse(read(root, '.changeset/pre.json')), { mode: 'pre', tag: 'beta' });
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

test('a release unit without a version fails (Changesets would silently skip it)', t => {
  const root = manifests(t);
  editJson(root, 'backend/package.json', pkg => delete pkg.version);
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backend\/package\.json needs an X\.Y\.Z or X\.Y\.Z-beta\.N "version"/);
});

test('beta versions pass, other prerelease channels fail', t => {
  const root = manifests(t);
  editJson(root, 'backend/package.json', pkg => { pkg.version = '0.2.0-beta.3'; });
  assert.equal(check(root).status, 0);
  editJson(root, 'backend/package.json', pkg => { pkg.version = '0.2.0-rc.1'; });
  assert.match(check(root).stderr, /backend\/package\.json needs an X\.Y\.Z or X\.Y\.Z-beta\.N "version"/);
});

test('web and desktop must share one version (fixed group)', t => {
  const root = manifests(t);
  editJson(root, 'frontend/package.json', pkg => { pkg.version = '0.2.0-beta.0'; });
  assert.match(check(root).stderr, /@tinychat\/frontend and exo-desktop share one version/);
});

test('the backend stays on 0.x and never takes a major changeset', t => {
  const root = manifests(t);
  editJson(root, 'backend/package.json', pkg => { pkg.version = '1.0.0'; });
  assert.match(check(root).stderr, /@tinychat\/backend stays on 0\.x, found 1\.0\.0/);

  const again = manifests(t);
  write(again, '.changeset/big-api.md', changesetFile({ '@tinychat/backend': 'major' }));
  write(again, '.changeset/pre/old-api.md', changesetFile({ '@tinychat/backend': 'major' }));
  const result = check(again);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.changeset\/big-api\.md bumps @tinychat\/backend major/);
  assert.match(result.stderr, /\.changeset\/pre\/old-api\.md bumps @tinychat\/backend major/);
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
  write(root, '.changeset/mixed.md', changesetFile({ '@tinychat/backend': 'patch', '@tinyboilerplate/core': 'patch' }));
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

test('pre mode must use the beta tag', t => {
  const root = manifests(t);
  write(root, '.changeset/pre.json', '{"mode":"pre","tag":"rc"}\n');
  assert.match(check(root).stderr, /\.changeset\/pre\.json must be exactly/);
});

test('a missing, corrupt or reshaped pre.json fails (it would stop every release after merge)', t => {
  const deleted = manifests(t);
  rmSync(join(deleted, '.changeset/pre.json'));
  assert.match(check(deleted).stderr, /\.changeset\/pre\.json is missing: main must stay in Changesets pre mode/);

  const corrupt = manifests(t);
  write(corrupt, '.changeset/pre.json', '{"mode": "pre", "tag": ');
  const corruptResult = check(corrupt);
  assert.equal(corruptResult.status, 1);
  assert.match(corruptResult.stderr, /\.changeset\/pre\.json is not valid JSON/);

  for (const text of ['[]', 'null', '{"mode":"pre","tag":"beta","changesets":[]}', '{"mode":"snapshot","tag":"beta"}']) {
    const reshaped = manifests(t);
    write(reshaped, '.changeset/pre.json', text);
    assert.match(check(reshaped).stderr, /\.changeset\/pre\.json must be exactly/, text);
  }
});

test('a PR that deletes pre.json fails the PR check even with a changeset', t => {
  const root = manifests(t);
  initRepo(root);
  commitAll(root, 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  rmSync(join(root, '.changeset/pre.json'));
  write(root, '.changeset/quiet.md', '---\n---\n');
  commitAll(root, 'drop pre mode');
  assert.match(check(root, '--since', 'main').stderr, /\.changeset\/pre\.json is missing/);
});

test('the recorded stable plan only exists with exit mode, and exit mode needs it', t => {
  const exitOnly = manifests(t);
  write(exitOnly, '.changeset/pre.json', '{"mode":"exit","tag":"beta"}\n');
  assert.match(check(exitOnly).stderr, /"exit" mode without \.changeset\/release-stable\.json/);

  const planOnly = manifests(t);
  write(planOnly, '.changeset/release-stable.json', '{"versions":{},"changesets":[]}\n');
  assert.match(check(planOnly).stderr, /release-stable\.json only belongs to the Release stable PR/);
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
  for (const dir of ['desktop', 'frontend']) editJson(root, `${dir}/package.json`, pkg => { pkg.version = '0.2.0-beta.1'; });

  const drift = check(root);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /Cargo\.toml has exo-desktop 0\.1\.0 but desktop\/package\.json has 0\.2\.0-beta\.1/);
  assert.match(drift.stderr, /Cargo\.lock has exo-desktop 0\.1\.0 but desktop\/package\.json has 0\.2\.0-beta\.1/);

  const sync = run('sync-desktop-version.mjs', ['--root', root]);
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(check(root).status, 0);
  assert.equal(read(root, 'desktop/src-tauri/Cargo.lock'), lockBefore.replace('name = "exo-desktop"\nversion = "0.1.0"', 'name = "exo-desktop"\nversion = "0.2.0-beta.1"'));
  assert.equal(read(root, 'desktop/src-tauri/Cargo.toml'), tomlBefore.replace(/^version = "0\.1\.0"$/m, 'version = "0.2.0-beta.1"'));

  const again = run('sync-desktop-version.mjs', ['--root', root]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, '');
});

test('--since requires the branch to add a changeset; an empty one opts out', t => {
  const root = manifests(t);
  initRepo(root);
  commitAll(root, 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'docs/notes.md', 'notes\n');
  commitAll(root, 'docs only');

  const missing = check(root, '--since', 'main');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No changeset added since main/);

  write(root, '.changeset/quiet-docs.md', '---\n---\n');
  commitAll(root, 'empty changeset');
  const optedOut = check(root, '--since', 'main');
  assert.equal(optedOut.status, 0, optedOut.stderr);
});

test('--since exempts only a PR that just flips pre.json to exit with its plan, whatever its branch name', t => {
  const root = manifests(t);
  initRepo(root);
  commitAll(root, 'base');
  git(root, 'checkout', '-q', '-b', 'any-name');
  write(root, '.changeset/pre.json', '{\n  "mode": "exit",\n  "tag": "beta"\n}\n');
  write(root, '.changeset/release-stable.json', '{"versions":{},"changesets":[]}\n');
  commitAll(root, 'release stable');
  const stable = check(root, '--since', 'main');
  assert.equal(stable.status, 0, stable.stderr);

  write(root, 'frontend/src/app.ts', 'export {};\n');
  commitAll(root, 'sneak in code');
  assert.match(check(root, '--since', 'main').stderr, /No changeset added since main/);
});

test('--since flags a major web/desktop bump that will need a confirmed release', t => {
  const root = manifests(t);
  initRepo(root);
  commitAll(root, 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  write(root, '.changeset/big.md', changesetFile({ '@tinychat/frontend': 'major' }));
  commitAll(root, 'major web');
  const result = check(root, '--since', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Major bump for @tinychat\/frontend: .*confirm=major-beta/);
});

test('check-beta-release-plan refuses unreleased majors unless confirmed, ignoring released ones', t => {
  const root = manifests(t);
  write(root, '.changeset/pre/released.md', changesetFile({ '@tinychat/frontend': 'major' }));
  assert.equal(run('check-beta-release-plan.mjs', ['--root', root]).status, 0);

  write(root, '.changeset/new-major.md', changesetFile({ 'exo-desktop': 'major' }));
  const refused = run('check-beta-release-plan.mjs', ['--root', root]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refuses unconfirmed major bumps: exo-desktop/);

  const confirmed = run('check-beta-release-plan.mjs', ['--root', root], { ALLOW_MAJOR_BETA: 'true' });
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.match(confirmed.stdout, /Explicit major release confirmed for: exo-desktop/);
});

// tag.mjs: a scratch repo exercising root, merge and squash commits.
function tagRepo(t) {
  const root = tempDir(t);
  initRepo(root);
  for (const [dir, name] of [['desktop', 'exo-desktop'], ['frontend', '@tinychat/frontend'], ['backend', '@tinychat/backend']]) {
    write(root, `${dir}/package.json`, `${JSON.stringify({ name, version: '0.1.0', private: true }, null, 2)}\n`);
  }
  return root;
}

const tag = root => run('tag.mjs', ['--root', root]);
const tagCommit = (cwd, name) => git(cwd, 'rev-parse', `refs/tags/${name}^{commit}`);

test('tag.mjs tags the commit that set each version, across root, merge and squash commits', t => {
  const root = tagRepo(t);
  const baseline = commitAll(root, 'baseline versions');
  write(root, 'README.md', 'later work\n');
  commitAll(root, 'unrelated later commit');

  const first = tag(root);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^tags=exo-desktop@0\.1\.0 @tinychat\/frontend@0\.1\.0 @tinychat\/backend@0\.1\.0$/m);
  for (const name of ['exo-desktop@0.1.0', '@tinychat/frontend@0.1.0', '@tinychat/backend@0.1.0']) assert.equal(tagCommit(root, name), baseline);
  assert.equal(git(root, 'cat-file', '-t', 'refs/tags/exo-desktop@0.1.0'), 'tag');

  // A merged branch sets a beta, followed by more main commits that touch the same file.
  git(root, 'checkout', '-q', '-b', 'side');
  editJson(root, 'desktop/package.json', pkg => { pkg.version = '0.2.0-beta.0'; });
  commitAll(root, 'beta version');
  git(root, 'checkout', '-q', 'main');
  write(root, 'backend/src.ts', 'export {};\n');
  commitAll(root, 'feature on main meanwhile');
  git(root, 'merge', '-q', '--no-ff', '-m', 'Merge beta', 'side');
  const merge = git(root, 'rev-parse', 'HEAD');
  editJson(root, 'desktop/package.json', pkg => { pkg.scripts = { dev: 'tauri dev' }; });
  commitAll(root, 'later desktop/package.json edit');

  // A squash-style commit sets a version, then another edit to the same package.json.
  editJson(root, 'frontend/package.json', pkg => { pkg.version = '0.1.1'; });
  const squash = commitAll(root, 'stable versions [skip ci]');
  editJson(root, 'frontend/package.json', pkg => { pkg.dependencies = { react: '^19' }; });
  commitAll(root, 'later frontend/package.json edit');

  const second = tag(root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(tagCommit(root, 'exo-desktop@0.2.0-beta.0'), merge);
  assert.equal(tagCommit(root, '@tinychat/frontend@0.1.1'), squash);
  assert.match(second.stdout, /@tinychat\/backend@0\.1\.0 already tagged/);

  const third = tag(root);
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stdout, /^tags=$/m);
});

test('tag.mjs fails loudly, creating nothing, when an existing tag points at the wrong commit', t => {
  const root = tagRepo(t);
  commitAll(root, 'baseline versions');
  write(root, 'README.md', 'later\n');
  const later = commitAll(root, 'later');
  git(root, 'tag', '-a', '@tinychat/backend@0.1.0', '-m', 'wrong', later);
  const result = tag(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tag @tinychat\/backend@0\.1\.0 points at/);
  assert.equal(git(root, 'tag', '-l'), '@tinychat/backend@0.1.0');
});

// The whole beta -> stable -> beta cycle with the real Changesets CLI from this repo's node_modules.
test('release cycle: betas with one web/desktop version, the Release stable PR, stable, back to beta', { skip: !existsSync(join(repo, 'node_modules/@changesets/cli')) && 'bun install first' }, t => {
  const root = manifests(t);
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
  write(root, '.gitignore', 'node_modules\n');
  write(root, '.changeset/quiet-docs.md', '---\n---\n');
  initRepo(root);
  const baseline = commitAll(root, 'baseline');
  const step = (name, args = [], env) => {
    const result = run(name, ['--root', root, ...args], env);
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  const versions = () => ['desktop', 'frontend', 'backend'].map(dir => version(root, dir));

  // Only an empty changeset: nothing to release, but the 0.1.0 baselines get tagged.
  assert.match(step('version.mjs'), /^channel=none$/m);
  assert.match(step('tag.mjs'), /^tags=exo-desktop@0\.1\.0 @tinychat\/frontend@0\.1\.0 @tinychat\/backend@0\.1\.0$/m);
  assert.equal(tagCommit(root, 'exo-desktop@0.1.0'), baseline);
  assert.match(step('stable-pr.mjs', ['--body', join(root, '..', 'none.md')]), /^open=false$/m);

  // A merged web + API change becomes betas; desktop follows the web version.
  write(root, '.changeset/web-api.md', changesetFile({ '@tinychat/frontend': 'minor', '@tinychat/backend': 'patch' }, 'Web and API change'));
  commitAll(root, 'feat: web and api (#1)');
  assert.match(step('version.mjs'), /^channel=beta$/m);
  assert.deepEqual(versions(), ['0.2.0-beta.0', '0.2.0-beta.0', '0.1.1-beta.0']);
  assert.match(git(root, 'log', '-1', '--format=%s'), /^chore\(release\): beta versions \[skip ci\]$/);
  assert.match(read(root, 'desktop/src-tauri/Cargo.lock'), /name = "exo-desktop"\nversion = "0\.2\.0-beta\.0"/);
  assert.ok(existsSync(join(root, '.changeset/pre/web-api.md')));
  assert.equal(git(root, 'status', '--porcelain'), '');
  const betaCommit = git(root, 'rev-parse', 'HEAD');
  assert.match(step('tag.mjs'), /^tags=exo-desktop@0\.2\.0-beta\.0 @tinychat\/frontend@0\.2\.0-beta\.0 @tinychat\/backend@0\.1\.1-beta\.0$/m);
  assert.equal(tagCommit(root, '@tinychat/backend@0.1.1-beta.0'), betaCommit);
  const betaDispatch = step('dispatch.mjs', ['--channel', 'beta', '--tags', 'exo-desktop@0.2.0-beta.0 @tinychat/frontend@0.2.0-beta.0 @tinychat/backend@0.1.1-beta.0', '--dry-run']);
  assert.doesNotMatch(betaDispatch, /deploy-production/);
  assert.match(betaDispatch, /^gh workflow run desktop-release\.yml --repo \S+ --ref main -f tag=exo-desktop@0\.2\.0-beta\.0$/m);

  write(root, '.changeset/web-fix.md', changesetFile({ '@tinychat/frontend': 'patch' }, 'Web fix'));
  commitAll(root, 'fix: web (#2)');
  assert.match(step('version.mjs'), /^channel=beta$/m);
  assert.deepEqual(versions(), ['0.2.0-beta.1', '0.2.0-beta.1', '0.1.1-beta.0']);

  // A backend major is rejected before anything is versioned.
  write(root, '.changeset/api-major.md', changesetFile({ '@tinychat/backend': 'major' }));
  commitAll(root, 'feat!: api (#3)');
  assert.match(check(root).stderr, /bumps @tinychat\/backend major/);
  const refused = run('version.mjs', ['--root', root]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /api-major\.md bumps @tinychat\/backend major/);
  assert.deepEqual(versions(), ['0.2.0-beta.1', '0.2.0-beta.1', '0.1.1-beta.0']);
  rmSync(join(root, '.changeset/api-major.md'));
  commitAll(root, 'revert: api major (#4)');

  // The Release stable PR: only pre.json flips, and its body shows the stable plan.
  const body = join(root, '..', 'stable.md');
  assert.match(step('stable-pr.mjs', ['--body', body]), /^open=true$/m);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(root, 'diff', '--name-only', 'main', 'release/stable'), '.changeset/pre.json\n.changeset/release-stable.json');
  assert.deepEqual(JSON.parse(git(root, 'show', 'release/stable:.changeset/release-stable.json')), {
    versions: { 'exo-desktop': '0.2.0', '@tinychat/frontend': '0.2.0', '@tinychat/backend': '0.1.1' },
    changesets: ['.changeset/pre/quiet-docs.md', '.changeset/pre/web-api.md', '.changeset/pre/web-fix.md'],
  });
  assert.match(read(root, '../stable.md'), /\| `@tinychat\/frontend` \| 0\.2\.0-beta\.1 \| \*\*0\.2\.0\*\* \| minor \|/);
  assert.match(read(root, '../stable.md'), /\| `exo-desktop` \| 0\.2\.0-beta\.1 \| \*\*0\.2\.0\*\* \| minor \|/);
  assert.match(read(root, '../stable.md'), /\| `@tinychat\/backend` \| 0\.1\.1-beta\.0 \| \*\*0\.1\.1\*\* \| patch \|/);
  assert.match(read(root, '../stable.md'), /- Web fix/);
  assert.match(read(root, '../stable.md'), /### exo-desktop@0\.2\.0\n\n- Same release as @tinychat\/frontend/);

  // Race 1: a feature lands on main, then the stale Release stable PR merges before any beta released it.
  git(root, 'switch', '-q', '-c', 'race-fresh', 'main');
  write(root, '.changeset/late.md', changesetFile({ '@tinychat/backend': 'minor' }, 'Late API change'));
  commitAll(root, 'feat: late api (#6)');
  git(root, 'merge', '-q', '--no-ff', '-m', 'Merge stale release stable', 'release/stable');
  assert.match(check(root).stderr, /no beta has released \.changeset\/late\.md yet/);
  const refusedStable = run('version.mjs', ['--root', root]);
  assert.equal(refusedStable.status, 1);
  assert.match(refusedStable.stderr, /no beta has released \.changeset\/late\.md yet/);
  assert.deepEqual(versions(), ['0.2.0-beta.1', '0.2.0-beta.1', '0.1.1-beta.0']);
  // The recovery the error describes: back to beta mode, and the late change ships as a beta first.
  write(root, '.changeset/pre.json', '{\n  "mode": "pre",\n  "tag": "beta"\n}\n');
  rmSync(join(root, '.changeset/release-stable.json'));
  write(root, '.changeset/back-to-beta.md', '---\n---\n');
  commitAll(root, 'chore(release): back to beta (#7)');
  assert.match(step('version.mjs'), /^channel=beta$/m);
  assert.deepEqual(versions(), ['0.2.0-beta.1', '0.2.0-beta.1', '0.2.0-beta.1']);

  // Race 2: a beta ships after the Release stable PR was prepared; the PR's recorded plan is now stale.
  git(root, 'switch', '-q', '-c', 'race-stale', 'main');
  write(root, '.changeset/late-fix.md', changesetFile({ '@tinychat/frontend': 'patch' }, 'Late web fix'));
  commitAll(root, 'fix: late web (#8)');
  assert.match(step('version.mjs'), /^channel=beta$/m);
  git(root, 'merge', '-q', '--no-ff', '-m', 'Merge stale release stable', 'release/stable');
  assert.match(check(root).stderr, /The Release stable PR is stale/);
  assert.equal(run('version.mjs', ['--root', root]).status, 1);
  assert.deepEqual(versions(), ['0.2.0-beta.2', '0.2.0-beta.2', '0.1.1-beta.0']);
  git(root, 'switch', '-q', 'main');

  // Merging the current Release stable PR releases stable and re-enters beta.
  git(root, 'merge', '-q', '--no-ff', '-m', 'Merge release stable (#5)', 'release/stable');
  assert.match(step('version.mjs'), /^channel=stable$/m);
  assert.deepEqual(versions(), ['0.2.0', '0.2.0', '0.1.1']);
  assert.deepEqual(JSON.parse(read(root, '.changeset/pre.json')), { mode: 'pre', tag: 'beta' });
  assert.equal(git(root, 'ls-files', '.changeset/pre', '.changeset/*.md', ':!.changeset/README.md'), '');
  assert.match(read(root, 'frontend/CHANGELOG.md'), /## 0\.2\.0\n/);
  const stableCommit = git(root, 'rev-parse', 'HEAD');
  assert.match(step('tag.mjs'), /^tags=exo-desktop@0\.2\.0 @tinychat\/frontend@0\.2\.0 @tinychat\/backend@0\.1\.1$/m);
  assert.equal(tagCommit(root, 'exo-desktop@0.2.0'), stableCommit);
  const stableDispatch = step('dispatch.mjs', ['--channel', 'stable', '--tags', 'exo-desktop@0.2.0 @tinychat/frontend@0.2.0 @tinychat/backend@0.1.1', '--dry-run']);
  assert.match(stableDispatch, /^gh workflow run deploy-production\.yml --repo \S+ --ref main -f tag=@tinychat\/backend@0\.1\.1 -f backend=true -f web=true$/m);
  assert.match(stableDispatch, /^gh workflow run desktop-release\.yml --repo \S+ --ref main -f tag=exo-desktop@0\.2\.0$/m);
  assert.match(step('stable-pr.mjs', ['--body', body]), /^open=false$/m);

  // The next change starts a new beta cycle from the stable versions.
  write(root, '.changeset/next.md', changesetFile({ '@tinychat/backend': 'minor' }, 'Next API'));
  commitAll(root, 'feat: next api (#6)');
  assert.match(step('version.mjs'), /^channel=beta$/m);
  assert.deepEqual(versions(), ['0.2.0', '0.2.0', '0.2.0-beta.0']);
});

// Production deploys: only stable releases, backend first, then web.
test('planDispatches deploys production only for stable tags, backend then web', () => {
  const deploys = (channel, tags) => planDispatches({ channel, tags }).filter(({ workflow }) => workflow === 'deploy-production.yml');
  assert.deepEqual(deploys('stable', ['exo-desktop@0.2.0', '@tinychat/frontend@0.2.0', '@tinychat/backend@0.1.1']), [{
    workflow: 'deploy-production.yml',
    ref: 'main',
    inputs: { tag: '@tinychat/backend@0.1.1', backend: 'true', web: 'true' },
    tags: ['@tinychat/backend@0.1.1', '@tinychat/frontend@0.2.0'],
  }]);
  assert.deepEqual(deploys('stable', ['exo-desktop@0.3.0', '@tinychat/frontend@0.3.0']).map(({ ref, inputs }) => ({ ref, inputs })),
    [{ ref: 'main', inputs: { tag: '@tinychat/frontend@0.3.0', backend: 'false', web: 'true' } }]);
  assert.deepEqual(deploys('stable', ['@tinychat/backend@0.1.2']).map(({ inputs }) => inputs), [{ tag: '@tinychat/backend@0.1.2', backend: 'true', web: 'false' }]);
  // Betas, and the 0.1.0 baseline tags of the first run (channel "none"), never deploy.
  assert.deepEqual(deploys('beta', ['@tinychat/frontend@0.2.0-beta.1', '@tinychat/backend@0.1.1-beta.0']), []);
  assert.deepEqual(deploys('none', ['exo-desktop@0.1.0', '@tinychat/frontend@0.1.0', '@tinychat/backend@0.1.0']), []);
  assert.throws(() => planDispatches({ channel: 'rc', tags: [] }), /Unknown release channel/);
});

test('dispatch.mjs refuses a production deploy whose stable tags are on different commits', t => {
  const root = tagRepo(t);
  const first = commitAll(root, 'versions');
  git(root, 'tag', '-a', '@tinychat/backend@0.1.1', '-m', 'backend', first);
  write(root, 'README.md', 'later\n');
  const later = commitAll(root, 'later');
  git(root, 'tag', '-a', '@tinychat/frontend@0.2.0', '-m', 'frontend', later);
  const result = run('dispatch.mjs', ['--root', root, '--channel', 'stable', '--tags', '@tinychat/frontend@0.2.0 @tinychat/backend@0.1.1', '--dry-run']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must all tag one commit/);
  assert.doesNotMatch(result.stdout, /gh workflow run/);
});

test('pages-production-commit.mjs deploys the exact target tree as a fast-forward of production', t => {
  const root = tagRepo(t);
  const old = commitAll(root, 'old release');
  git(root, 'branch', 'production', old);
  write(root, 'frontend/src/app.ts', 'export const v = 2;\n');
  const target = commitAll(root, 'chore(release): stable versions [skip ci]');
  const make = args => run('pages-production-commit.mjs', ['--root', root, '--production', 'refs/heads/production', '--main', 'main', ...args]);

  const result = make(['--label', '@tinychat/frontend@0.2.0', '--body', 'Run https://example.invalid/run']);
  assert.equal(result.status, 0, result.stderr);
  const commit = /^commit=([0-9a-f]{40})$/m.exec(result.stdout)[1];
  assert.match(result.stdout, new RegExp(`^previous=${old}$`, 'm'));
  assert.equal(git(root, 'rev-parse', `${commit}^{tree}`), git(root, 'rev-parse', `${target}^{tree}`));
  assert.equal(git(root, 'log', '-1', '--format=%P', commit), `${old} ${target}`);
  assert.equal(git(root, 'log', '-1', '--format=%B', commit), `deploy(web): @tinychat/frontend@0.2.0\n\nSource: ${target}\nRun https://example.invalid/run`);
  git(root, 'merge-base', '--is-ancestor', 'production', commit);

  // Rolling back to an older release is also a fast-forward commit with that release's tree.
  git(root, 'branch', '-f', 'production', commit);
  const rollback = make(['--target', old, '--label', 'hotfix']);
  assert.equal(rollback.status, 0, rollback.stderr);
  const back = /^commit=([0-9a-f]{40})$/m.exec(rollback.stdout)[1];
  assert.equal(git(root, 'rev-parse', `${back}^{tree}`), git(root, 'rev-parse', `${old}^{tree}`));
  assert.equal(git(root, 'log', '-1', '--format=%P', back), `${commit} ${old}`);

  // An out-of-band push (not a deploy commit, not from main) is refused.
  git(root, 'checkout', '-q', '-b', 'rogue', back);
  write(root, 'frontend/src/app.ts', 'export const v = "rogue";\n');
  const rogue = commitAll(root, 'deploy(web): looks official');
  git(root, 'checkout', '-q', 'main');
  git(root, 'branch', '-f', 'production', rogue);
  const refused = make(['--label', 'x']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /pushed out of band/);

  git(root, 'branch', '-D', 'production');
  const missing = make(['--label', 'x']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /refs\/heads\/production does not exist.*Cloudflare Pages production branch/);
});

// Real Cloudflare Pages check-run summaries (production f33cd32, preview 9545f4b), trimmed.
const pagesRun = (id, fields) => ({ id, name: 'Cloudflare Pages', app: { slug: 'cloudflare-workers-and-pages' }, details_url: `https://dash.cloudflare.com/${id}`, ...fields });
const PRODUCTION_SUMMARY = "<table><tr><td><strong>Latest commit:</strong> </td><td>\n<code>f33cd32</code>\n</td></tr>\n<tr><td><strong>Status:</strong></td><td>&nbsp;✅&nbsp; Deploy successful!</td></tr>\n<tr><td><strong>Preview URL:</strong></td><td>\n<a href='https://465be04b.tinychat-4jq.pages.dev'>https://465be04b.tinychat-4jq.pages.dev</a>\n</td></tr>\n</table>";
const PREVIEW_SUMMARY = PRODUCTION_SUMMARY.replace('</table>', "<tr><td><strong>Branch Preview URL:</strong></td><td>\n<a href='https://production.tinychat-4jq.pages.dev'>https://production.tinychat-4jq.pages.dev</a>\n</td></tr>\n</table>");

test('classifyPagesCheckRuns tells a live production deploy from waiting, failed and preview builds', () => {
  assert.deepEqual(classifyPagesCheckRuns([]), { state: 'waiting' });
  assert.deepEqual(classifyPagesCheckRuns([{ ...pagesRun(1, { status: 'completed', conclusion: 'success' }), app: { slug: 'other' } }]), { state: 'waiting' });
  assert.deepEqual(classifyPagesCheckRuns([pagesRun(1, { status: 'in_progress', conclusion: null })]), { state: 'waiting' });

  const production = classifyPagesCheckRuns([pagesRun(1, { status: 'completed', conclusion: 'success', output: { summary: PRODUCTION_SUMMARY } })]);
  assert.equal(production.state, 'production');
  assert.equal(production.deploymentUrl, 'https://465be04b.tinychat-4jq.pages.dev');

  assert.equal(classifyPagesCheckRuns([pagesRun(1, { status: 'completed', conclusion: 'success', output: { summary: PREVIEW_SUMMARY } })]).state, 'preview');
  const failed = classifyPagesCheckRuns([pagesRun(1, { status: 'completed', conclusion: 'failure', output: { title: 'Build failed', summary: '' } })]);
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /failure: Build failed/);

  // The newest run (a retry) decides.
  assert.equal(classifyPagesCheckRuns([
    pagesRun(1, { status: 'completed', conclusion: 'failure', output: { summary: '' } }),
    pagesRun(2, { status: 'completed', conclusion: 'success', output: { summary: PRODUCTION_SUMMARY } }),
  ]).state, 'production');
});

// The `on:` block of a workflow file.
const triggers = rel => /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(read(repo, rel))[1];

test('pushes to main no longer deploy production; only the gated Deploy production workflow does', () => {
  const phala = triggers('.github/workflows/deploy-backend-phala.yml');
  assert.doesNotMatch(phala, /^\s+(push|workflow_dispatch):/m);
  assert.match(phala, /^ {2}workflow_call:/m);
  const phalaText = read(repo, '.github/workflows/deploy-backend-phala.yml');
  // It deploys the gated commit it is given, never the caller's (main's) SHA.
  assert.match(phala, /^ {2}workflow_call:\n {4}inputs:\n {6}ref:/m);
  assert.doesNotMatch(phalaText, /github\.sha|GITHUB_SHA/);
  assert.match(phalaText, /ref: \$\{\{ inputs\.ref \}\}/);
  assert.match(phalaText, /BUILD_REVISION=\$\{\{ inputs\.ref \}\}/);
  assert.match(phalaText, /if \[ "\$revision" = "\$DEPLOY_SHA" \] && \[ "\$version" = "\$expected_version" \]/);
  assert.match(phalaText, /state=changed-unverified/);

  const production = read(repo, '.github/workflows/deploy-production.yml');
  assert.doesNotMatch(triggers('.github/workflows/deploy-production.yml'), /^\s+(push|pull_request):/m);
  assert.match(production, /uses: \.\/\.github\/workflows\/deploy-backend-phala\.yml/);
  assert.match(production, /needs: \[target, backend\]/);
  // Web needs the backend to be skipped, or to prove it serves this commit and version.
  assert.match(production, /needs\.backend\.result == 'skipped' \|\|\s+\(needs\.backend\.result == 'success' && needs\.backend\.outputs\.revision == needs\.target\.outputs\.sha &&\s+needs\.backend\.outputs\.version == needs\.target\.outputs\.backend-version\)/);
  assert.match(production, /node scripts\/release\/deploy-target\.mjs --commit "\$commit"/);
  // Runs from main only; the backend gets the gated SHA.
  assert.match(production, /EXPECTED: \$\{\{ github\.repository \}\}\/\.github\/workflows\/deploy-production\.yml@refs\/heads\/main/);
  assert.match(production, /if \[ "\$GITHUB_REF" != refs\/heads\/main \] \|\| \[ "\$WORKFLOW_REF" != "\$EXPECTED" \]; then/);
  assert.match(production, /uses: \.\/\.github\/workflows\/deploy-backend-phala\.yml\n\s+with:\n\s+ref: \$\{\{ needs\.target\.outputs\.sha \}\}/);

  const release = read(repo, '.github/workflows/release.yml');
  assert.ok(release.indexOf('node scripts/release/dispatch.mjs') > release.indexOf('push --atomic origin HEAD:refs/heads/main'),
    'the Release job dispatches only after the tags are pushed');
});

// Manual deploys: a stable release tag per selected unit on a main commit, or an explicitly confirmed hotfix.
function deployRepo(t) {
  const root = tagRepo(t);
  editJson(root, 'backend/package.json', pkg => { pkg.version = '0.1.1'; });
  editJson(root, 'frontend/package.json', pkg => { pkg.version = '0.2.0'; });
  const stable = commitAll(root, 'chore(release): stable versions [skip ci]');
  git(root, 'tag', '-a', '@tinychat/backend@0.1.1', '-m', 'backend', stable);
  git(root, 'tag', '-a', '@tinychat/frontend@0.2.0', '-m', 'frontend', stable);
  return { root, stable };
}
const target = (root, ...args) => run('deploy-target.mjs', ['--root', root, '--main', 'main', ...args]);

test('deploy-target.mjs accepts a stable release tag on main for each selected unit', t => {
  const { root } = deployRepo(t);
  const both = target(root, '--backend', 'true', '--web', 'true');
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stdout, /^label=@tinychat\/backend@0\.1\.1 @tinychat\/frontend@0\.2\.0$/m);
  assert.match(both.stdout, /^released=true$/m);
  assert.match(both.stdout, /^backend-version=0\.1\.1$/m);
  assert.equal(target(root, '--backend', 'false', '--web', 'false').status, 1);
});

test('deploy-target.mjs refuses unreleased commits unless allow_unreleased and the full SHA are given', t => {
  const { root } = deployRepo(t);
  write(root, 'backend/src/fix.ts', 'export {};\n');
  const fix = commitAll(root, 'fix: hotfix on main');
  const refused = target(root, '--backend', 'true', '--web', 'false');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /@tinychat\/backend@0\.1\.1 does not tag/);
  assert.match(refused.stderr, new RegExp(`confirm_sha=${fix}`));

  assert.equal(target(root, '--backend', 'true', '--web', 'false', '--allow-unreleased', 'true').status, 1, 'no SHA');
  assert.equal(target(root, '--backend', 'true', '--web', 'false', '--allow-unreleased', 'true', '--confirm-sha', fix.slice(0, 12)).status, 1, 'short SHA');
  assert.equal(target(root, '--backend', 'true', '--web', 'false', '--allow-unreleased', 'false', '--confirm-sha', fix).status, 1, 'not allowed');
  const hotfix = target(root, '--backend', 'true', '--web', 'false', '--allow-unreleased', 'true', '--confirm-sha', fix);
  assert.equal(hotfix.status, 0, hotfix.stderr);
  assert.match(hotfix.stdout, /^released=false$/m);
  assert.match(hotfix.stdout, /^label=unreleased hotfix [0-9a-f]{12}$/m);

  // Beta versions and commits off main are unreleased too.
  const beta = deployRepo(t).root;
  editJson(beta, 'backend/package.json', pkg => { pkg.version = '0.1.2-beta.0'; });
  commitAll(beta, 'beta');
  assert.match(target(beta, '--backend', 'true', '--web', 'false').stderr, /0\.1\.2-beta\.0, not a stable version/);
  const side = deployRepo(t).root;
  git(side, 'checkout', '-q', '-b', 'side');
  write(side, 'x.txt', 'x\n');
  const off = commitAll(side, 'off main');
  git(side, 'tag', '-f', '-a', '@tinychat/backend@0.1.1', '-m', 'moved', off);
  assert.match(target(side, '--backend', 'true', '--web', 'false').stderr, /is not on main/);
});

// Desktop releases: one build per new exo-desktop tag, numeric Apple bundle versions, release plan and notes.
test('planDispatches builds a desktop release from main for each new beta or stable exo-desktop tag, never for baselines', () => {
  const desktop = (channel, tags) => planDispatches({ channel, tags }).filter(({ workflow }) => workflow === 'desktop-release.yml').map(({ ref, inputs }) => `${ref} ${inputs.tag}`);
  assert.deepEqual(desktop('beta', ['exo-desktop@0.2.0-beta.3', '@tinychat/frontend@0.2.0-beta.3']), ['main exo-desktop@0.2.0-beta.3']);
  assert.deepEqual(desktop('stable', ['exo-desktop@0.2.0', '@tinychat/frontend@0.2.0', '@tinychat/backend@0.1.1']), ['main exo-desktop@0.2.0']);
  assert.deepEqual(desktop('beta', ['@tinychat/backend@0.1.2-beta.0']), []);
  assert.deepEqual(desktop('none', ['exo-desktop@0.1.0', '@tinychat/frontend@0.1.0', '@tinychat/backend@0.1.0']), []);
});

test('desktopBundleVersions: numeric X.Y.Z short version and a build number that grows with every release', () => {
  assert.deepEqual(desktopBundleVersions('0.2.0-beta.3'), { shortVersion: '0.2.0', bundleVersion: '200003', prerelease: true });
  assert.deepEqual(desktopBundleVersions('0.2.0'), { shortVersion: '0.2.0', bundleVersion: '200999', prerelease: false });
  assert.deepEqual(desktopBundleVersions('1.12.4-beta.0'), { shortVersion: '1.12.4', bundleVersion: '11204000', prerelease: true });
  const order = ['0.1.0', '0.2.0-beta.0', '0.2.0-beta.1', '0.2.0-beta.12', '0.2.0', '0.2.1-beta.0', '0.2.1', '0.10.0', '1.0.0-beta.0', '1.0.0', '213.99.99'];
  const builds = order.map(version => Number(desktopBundleVersions(version).bundleVersion));
  assert.deepEqual([...builds].sort((a, b) => a - b), builds);
  assert.ok(builds.at(-1) < 2 ** 31);
  for (const version of order) assert.match(desktopBundleVersions(version).shortVersion, /^\d+\.\d+\.\d+$/);
  assert.throws(() => desktopBundleVersions('0.100.0'), /does not fit/);
  assert.throws(() => desktopBundleVersions('0.2.0-beta.999'), /does not fit/);
  assert.throws(() => desktopBundleVersions('0.2.0-rc.1'), /must be X\.Y\.Z or X\.Y\.Z-beta\.N/);
});

test('changelogSection returns one version\'s entries and treats "No changes" as empty', () => {
  const text = '# exo-desktop\n\n## 0.2.0-beta.1\n\n### Patch Changes\n\n- a328407: Desktop fix Y\n\n## 0.2.0-beta.0\n\nNo changes in this release.\n';
  assert.equal(changelogSection(text, '0.2.0-beta.1'), '### Patch Changes\n\n- a328407: Desktop fix Y');
  assert.equal(changelogSection(text, '0.2.0-beta.0'), '');
  assert.equal(changelogSection(text, '0.2.0'), '');
});

test('desktop-bundle-config.mjs writes the Info.plist overlay for tauri build --config', t => {
  const root = manifests(t);
  for (const dir of ['desktop', 'frontend']) editJson(root, `${dir}/package.json`, pkg => { pkg.version = '0.3.0-beta.4'; });
  const out = join(tempDir(t), 'bundle');
  const result = run('desktop-bundle-config.mjs', ['--root', root, '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^version=0\.3\.0-beta\.4$/m);
  assert.match(result.stdout, /^short-version=0\.3\.0$/m);
  assert.match(result.stdout, /^bundle-version=300004$/m);
  assert.match(result.stdout, /^prerelease=true$/m);
  const config = JSON.parse(read(out, 'tauri.bundle.conf.json'));
  assert.deepEqual(Object.keys(config), ['bundle']);
  assert.equal(config.bundle.macOS.infoPlist, join(out, 'Info.bundle-version.plist'));
  const plist = read(out, 'Info.bundle-version.plist');
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\n\t<string>0\.3\.0<\/string>/);
  assert.match(plist, /<key>CFBundleVersion<\/key>\n\t<string>300004<\/string>/);
});

// A repo whose main has a release commit at `version`, tagged `exo-desktop@<version>`.
function releasePlanRepo(t, version) {
  const root = manifests(t);
  for (const dir of ['desktop', 'frontend']) editJson(root, `${dir}/package.json`, pkg => { pkg.version = version; });
  write(root, 'desktop/CHANGELOG.md', `# exo-desktop\n\n## ${version}\n\n### Patch Changes\n\n- abc1234: Desktop fix Y\n\n## 0.1.0\n\n- Old\n`);
  write(root, 'frontend/CHANGELOG.md', `# @tinychat/frontend\n\n## ${version}\n\n### Minor Changes\n\n- def5678: Web feature X\n`);
  initRepo(root);
  const sha = commitAll(root, 'chore(release): versions [skip ci]');
  git(root, 'tag', '-a', `exo-desktop@${version}`, '-m', version, sha);
  return { root, sha };
}
// signing is the EXO_DESKTOP_SIGNING value passed as --signing; null leaves the flag out.
function releasePlan(t, root, tag, signing = 'required') {
  const notes = join(tempDir(t), 'notes.md');
  const args = ['--root', root, '--tag', tag, '--notes', notes, '--main', 'main', ...(signing === null ? [] : ['--signing', signing])];
  return { result: run('desktop-release-plan.mjs', args), notes };
}

test('desktop-release-plan.mjs: a beta tag on main becomes a pre-release built from that commit', t => {
  const { root, sha } = releasePlanRepo(t, '0.2.0-beta.3');
  // Later main work must not leak into the release: data comes from the tag's commit, not the checkout.
  editJson(root, 'desktop/package.json', pkg => { pkg.version = '0.2.0-beta.4'; });
  write(root, 'desktop/CHANGELOG.md', '# exo-desktop\n\n## 0.2.0-beta.3\n\n- Rewritten later\n');
  commitAll(root, 'later');
  const { result, notes } = releasePlan(t, root, 'exo-desktop@0.2.0-beta.3');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^tag=exo-desktop@0\.2\.0-beta\.3$/m);
  assert.match(result.stdout, new RegExp(`^sha=${sha}$`, 'm'));
  assert.match(result.stdout, /^channel=beta$/m);
  assert.match(result.stdout, /^prerelease=true$/m);
  assert.match(result.stdout, /^title=Exo 0\.2\.0-beta\.3 \(beta\)$/m);
  assert.match(result.stdout, /^asset-prefix=Exo_0\.2\.0-beta\.3_aarch64$/m);
  assert.match(result.stdout, /^signing=required$/m);
  const text = readFileSync(notes, 'utf8');
  assert.match(text, /\*\*Beta\.\*\* A pre-release of Exo 0\.2\.0/);
  assert.match(text, /## Desktop\n\n### Patch Changes\n\n- abc1234: Desktop fix Y\n/);
  assert.match(text, /## Web app \(bundled, @tinychat\/frontend@0\.2\.0-beta\.3\)\n\n### Minor Changes\n\n- def5678: Web feature X\n/);
  assert.match(text, /CFBundleShortVersionString 0\.2\.0, CFBundleVersion 200003/);
  assert.match(text, new RegExp(`built from \`${sha}\``));
  assert.match(text, /Developer ID signed, notarized and stapled/);
  assert.doesNotMatch(text, /UNSIGNED/);
  assert.doesNotMatch(text, /- Old|Rewritten later/);
});

test('desktop-release-plan.mjs: a stable tag becomes the latest release', t => {
  const { root } = releasePlanRepo(t, '0.2.0');
  const { result, notes } = releasePlan(t, root, 'exo-desktop@0.2.0');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^channel=stable$/m);
  assert.match(result.stdout, /^prerelease=false$/m);
  assert.match(result.stdout, /^title=Exo 0\.2\.0$/m);
  assert.doesNotMatch(readFileSync(notes, 'utf8'), /Beta/);
});

const UNSIGNED_NOTICE = '> **UNSIGNED — macOS will warn; right-click → Open, or `xattr -dr com.apple.quarantine Exo.app`.**';

test('desktop-release-plan.mjs --signing unsigned: a beta stays a pre-release, marked UNSIGNED in title and notes', t => {
  const { root, sha } = releasePlanRepo(t, '0.2.0-beta.3');
  const { result, notes } = releasePlan(t, root, 'exo-desktop@0.2.0-beta.3', 'unsigned');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^sha=${sha}$`, 'm'));
  assert.match(result.stdout, /^signing=unsigned$/m);
  assert.match(result.stdout, /^channel=beta$/m);
  assert.match(result.stdout, /^prerelease=true$/m);
  assert.match(result.stdout, /^title=Exo 0\.2\.0-beta\.3 \(beta, UNSIGNED\)$/m);
  assert.match(result.stdout, /^asset-prefix=Exo_0\.2\.0-beta\.3_aarch64$/m);
  const text = readFileSync(notes, 'utf8');
  assert.ok(text.startsWith(`${UNSIGNED_NOTICE} This build is not Developer ID signed or notarized.\n\n> **Beta.**`), text);
  assert.match(text, /^- UNSIGNED: not Developer ID signed or notarized\. Check downloads against SHA256SUMS\.txt\.$/m);
  assert.doesNotMatch(text, /Developer ID signed, notarized and stapled/);
  assert.match(text, /## Desktop\n\n### Patch Changes\n\n- abc1234: Desktop fix Y\n/);
});

test('desktop-release-plan.mjs --signing unsigned: a stable is still the latest release, marked UNSIGNED', t => {
  const { root } = releasePlanRepo(t, '0.2.0');
  const { result, notes } = releasePlan(t, root, 'exo-desktop@0.2.0', 'unsigned');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^signing=unsigned$/m);
  assert.match(result.stdout, /^channel=stable$/m);
  assert.match(result.stdout, /^prerelease=false$/m);
  assert.match(result.stdout, /^title=Exo 0\.2\.0 \(UNSIGNED\)$/m);
  const text = readFileSync(notes, 'utf8');
  assert.ok(text.startsWith(UNSIGNED_NOTICE), text);
  assert.doesNotMatch(text, /Beta|Developer ID signed, notarized and stapled/);
});

test('desktop-release-plan.mjs refuses a missing or unknown EXO_DESKTOP_SIGNING instead of guessing', t => {
  const { root } = releasePlanRepo(t, '0.2.0-beta.3');
  for (const signing of [null, '', 'Required', 'signed', 'optional', 'true']) {
    const { result, notes } = releasePlan(t, root, 'exo-desktop@0.2.0-beta.3', signing);
    assert.equal(result.status, 1, `--signing ${signing}`);
    assert.match(result.stderr, /EXO_DESKTOP_SIGNING must be "required" \(Developer ID sign \+ notarize\) or "unsigned" \(publish marked UNSIGNED\), got /);
    assert.match(result.stderr, /gh variable set EXO_DESKTOP_SIGNING --body <required\|unsigned>/);
    assert.doesNotMatch(result.stdout, /^(title|signing)=/m);
    assert.equal(existsSync(notes), false);
  }
});

test('desktop-release-plan.mjs refuses bad tags, tags off main and version mismatches', t => {
  const { root, sha } = releasePlanRepo(t, '0.2.0-beta.3');
  assert.match(releasePlan(t, root, 'refs/heads/main').result.stderr, /need an exo-desktop@<X\.Y\.Z or X\.Y\.Z-beta\.N> tag/);
  assert.match(releasePlan(t, root, '@tinychat/frontend@0.2.0-beta.3').result.stderr, /need an exo-desktop@/);
  assert.match(releasePlan(t, root, 'exo-desktop@0.2.0-beta.9').result.stderr, /Tag exo-desktop@0\.2\.0-beta\.9 does not exist/);

  git(root, 'tag', '-a', 'exo-desktop@0.2.0-beta.2', '-m', 'wrong version', sha);
  assert.match(releasePlan(t, root, 'exo-desktop@0.2.0-beta.2').result.stderr, /does not match desktop\/package\.json version 0\.2\.0-beta\.3/);

  git(root, 'checkout', '-q', '-b', 'side');
  editJson(root, 'desktop/package.json', pkg => { pkg.version = '0.2.0-beta.5'; });
  editJson(root, 'frontend/package.json', pkg => { pkg.version = '0.2.0-beta.5'; });
  const off = commitAll(root, 'not on main');
  git(root, 'tag', '-a', 'exo-desktop@0.2.0-beta.5', '-m', 'off main', off);
  const offMain = releasePlan(t, root, 'exo-desktop@0.2.0-beta.5').result;
  assert.equal(offMain.status, 1);
  assert.match(offMain.stderr, /is not on main: only release tags on main are built/);
});

test('the Exo build is defined once and shared by CI and releases', () => {
  for (const name of ['desktop.yml', 'desktop-release.yml', 'desktop-build.yml']) {
    const text = read(repo, `.github/workflows/${name}`);
    for (const command of ['tauri build', 'tauri bundle']) {
      const runs = (text.match(new RegExp(`^\\s+(?:run: )?bun run --cwd desktop ${command}`, 'gm')) ?? []).length;
      assert.equal(runs, name === 'desktop-build.yml' ? 1 : 0, `${name} runs ${command} ${runs} times`);
    }
  }
  assert.match(triggers('.github/workflows/desktop-build.yml'), /^ {2}workflow_call:/m);
  for (const name of ['desktop.yml', 'desktop-release.yml']) assert.match(read(repo, `.github/workflows/${name}`), /uses: \.\/\.github\/workflows\/desktop-build\.yml/);
  const build = read(repo, '.github/workflows/desktop-build.yml');
  assert.match(build, /shared-key: exo-desktop-macos-arm64/);
  assert.match(build, /tauri build --no-bundle --config "\$TAURI_BUNDLE_CONFIG"/);
  assert.match(build, /tauri bundle --config "\$TAURI_BUNDLE_CONFIG"/);
  // Only main's own CI builds write the cache; release and signing builds only restore it.
  assert.match(build, /SAVE_CACHE: \$\{\{ github\.ref == 'refs\/heads\/main' && inputs\.ref == '' && !inputs\.sign \}\}/);
  assert.match(build, /ref: \$\{\{ inputs\.ref \|\| github\.sha \}\}/);
});

test('desktop releases run main\'s workflow on a validated tag and publish unsigned only when EXO_DESKTOP_SIGNING says so', () => {
  const release = read(repo, '.github/workflows/desktop-release.yml');
  assert.match(triggers('.github/workflows/desktop-release.yml'), /^ {2}workflow_dispatch:\n {4}inputs:\n {6}tag:/m);
  assert.match(release, /if \[ "\$GITHUB_REF" != refs\/heads\/main \] \|\| \[ "\$WORKFLOW_REF" != "\$EXPECTED" \]; then/);
  assert.match(release, /EXPECTED: \$\{\{ github\.repository \}\}\/\.github\/workflows\/desktop-release\.yml@refs\/heads\/main/);
  assert.match(release, /ref: \$\{\{ needs\.plan\.outputs\.sha \}\}/);
  // The variable is read once, by the plan (which validates it); every later job uses the plan's value.
  assert.equal((release.match(/vars\.EXO_DESKTOP_SIGNING/g) ?? []).length, 1);
  const plan = release.slice(release.indexOf('  plan:'), release.indexOf('  build:'));
  assert.match(plan, /SIGNING: \$\{\{ vars\.EXO_DESKTOP_SIGNING \}\}/);
  assert.match(plan, /node scripts\/release\/desktop-release-plan\.mjs --tag "\$TAG" --notes "\$RUNNER_TEMP\/release-notes\.md" --signing "\$SIGNING"/);
  assert.match(plan, /signing: \$\{\{ steps\.plan\.outputs\.signing \}\}/);
  // Signing (and the desktop-release environment) only for an explicit `required`; no secrets are handed down.
  assert.match(release, /uses: \.\/\.github\/workflows\/desktop-build\.yml\n\s+with:\n(?:.*\n){2}\s+sign: \$\{\{ needs\.plan\.outputs\.signing == 'required' \}\}\n/);
  assert.doesNotMatch(release, /secrets: inherit|secrets\./);
  const publish = release.slice(release.indexOf('  publish:'));
  assert.match(publish, /SIGNING: \$\{\{ needs\.plan\.outputs\.signing \}\}/);
  const signedCheck = publish.indexOf('if [ "$SIGNING" != unsigned ] && [ "$SIGNED" != true ]; then');
  assert.ok(signedCheck !== -1 && signedCheck < publish.indexOf('gh release create'), 'the signed check precedes any release write');
  assert.match(publish, /--title "\$TITLE"/);
});

// Tags are mutable: every non-local action runs from a full commit SHA, with the version it was resolved from noted.
test('every workflow pins its actions to a full commit SHA', () => {
  const unpinned = [];
  for (const name of readdirSync(join(repo, '.github/workflows')).filter(file => /\.ya?ml$/.test(file))) {
    read(repo, `.github/workflows/${name}`).split('\n').forEach((line, index) => {
      const use = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
      if (!use || use[1].startsWith('./')) return;
      if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(use[1]) || !/^\s+#\s*\S/.test(use[2])) unpinned.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(unpinned, [], 'pin each action as owner/repo@<40-hex SHA> # vX.Y.Z');
});

// Release tags and the production branch are pushed only with the release-push deploy key (ruleset bypass).
test('release tags and production go over the release-push deploy key, from main-only environments', () => {
  const release = read(repo, '.github/workflows/release.yml');
  const production = read(repo, '.github/workflows/deploy-production.yml');
  assert.match(release, /environment: release-push/);
  assert.match(release, /scripts\/release\/deploy-key-push\.sh --atomic HEAD:refs\/heads\/main "\$\{refs\[@\]\}"/);
  assert.match(release, /RELEASE_PUSH_SSH_KEY: \$\{\{ secrets\.RELEASE_PUSH_SSH_KEY \}\}/);
  assert.doesNotMatch(release, /extraheader=\$auth" push --atomic/);
  const web = production.slice(production.indexOf('  web:'), production.indexOf('  report:'));
  assert.match(web, /environment: release-push/);
  assert.match(web, /run: scripts\/release\/deploy-key-push\.sh "\$COMMIT:refs\/heads\/production"/);
  assert.doesNotMatch(web, /contents: write|extraheader/);
  for (const text of [release, production]) assert.doesNotMatch(text, /push[^\n]*origin[^\n]*refs\/(tags|heads\/production)/);
});

test('deploy-key-push.sh refuses to run without the deploy key', () => {
  const result = spawnSync('bash', [join(repo, 'scripts/release/deploy-key-push.sh'), 'HEAD:refs/heads/production'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'TinyCloudLabs/tinychat', RELEASE_PUSH_SSH_KEY: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::RELEASE_PUSH_SSH_KEY is not set/);
});

test('deploy-target.mjs gates an older release commit from main\'s checkout (rollback)', t => {
  const { root, stable } = deployRepo(t);
  write(root, 'backend/src/next.ts', 'export {};\n');
  commitAll(root, 'later main work');
  const rollback = target(root, '--commit', 'refs/tags/@tinychat/backend@0.1.1', '--backend', 'true', '--web', 'false');
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.match(rollback.stdout, new RegExp(`^sha=${stable}$`, 'm'));
  assert.match(rollback.stdout, /^label=@tinychat\/backend@0\.1\.1$/m);
});

// Signing: only main's release workflow reaches the desktop-release environment, compiles without secrets, and
// verifies signing and notarization before anything is uploaded or published.
test('release builds are signed from main only, compiled without secrets, and verified before upload', () => {
  const build = read(repo, '.github/workflows/desktop-build.yml');
  assert.match(build, /environment: \$\{\{ inputs\.sign && 'desktop-release' \|\| '' \}\}/);
  assert.match(read(repo, '.github/workflows/desktop-release.yml'), /uses: \.\/\.github\/workflows\/desktop-build\.yml\n\s+with:\n(?:.*\n){2}\s+sign: \$\{\{ needs\.plan\.outputs\.signing == 'required' \}\}\n/);
  assert.doesNotMatch(read(repo, '.github/workflows/desktop.yml'), /sign:/);
  assert.doesNotMatch(build, /continue-on-error/);

  const steps = ['Verify signing provenance', 'Check signing secrets', 'Build Exo desktop app', 'Write the App Store Connect API key',
    'Bundle Exo (signed and notarized for releases)', 'Notarize and staple the DMG', 'Verify signing and notarization', 'Package .app', 'Upload dmg + app'];
  const order = steps.map(name => build.indexOf(`- name: ${name}\n`));
  assert.ok(order.every(index => index !== -1), `steps: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'provenance and secrets are checked first; verification passes before packaging and upload');
  assert.ok(build.indexOf('${{ secrets.') > build.indexOf('- name: Verify signing provenance\n'), 'no secret is referenced before the provenance check');
  for (const name of ['Verify signing provenance', 'Check signing secrets', 'Write the App Store Connect API key', 'Notarize and staple the DMG', 'Verify signing and notarization']) {
    assert.match(build, new RegExp(`- name: ${name}\\n(?:\\s+id: \\w+\\n)?\\s+if: inputs\\.sign\\n`));
  }
  const provenance = build.slice(build.indexOf('- name: Verify signing provenance'), build.indexOf('- name: Check signing secrets'));
  assert.match(provenance, /EXPECTED: \$\{\{ github\.repository \}\}\/\.github\/workflows\/desktop-release\.yml@refs\/heads\/main/);
  assert.match(provenance, /\[ "\$GITHUB_REF" != refs\/heads\/main \]/);
  assert.match(provenance, /git merge-base --is-ancestor "\$WORKFLOW_SHA" origin\/main/);
  assert.match(provenance, /git merge-base --is-ancestor "\$sha" origin\/main/);
  assert.match(provenance, /git tag --points-at "\$sha"/);

  // Signing secrets reach only the bundle step (tauri bundle compiles nothing), never the compile step.
  const step = name => build.slice(build.indexOf(`- name: ${name}\n`), build.indexOf('\n\n', build.indexOf(`- name: ${name}\n`)));
  assert.doesNotMatch(step('Build Exo desktop app'), /secrets\./);
  assert.match(step('Bundle Exo (signed and notarized for releases)'), /secrets\.APPLE_CERTIFICATE/);
  assert.match(build, /signed: \$\{\{ steps\.verify\.outputs\.signed \|\| 'false' \}\}/);

  const conf = JSON.parse(read(repo, 'desktop/src-tauri/tauri.conf.json'));
  assert.equal(conf.bundle.macOS.hardenedRuntime, true);
  assert.equal(conf.bundle.macOS.entitlements, 'Entitlements.plist');
  assert.match(read(repo, 'desktop/src-tauri/Entitlements.plist'), /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
  assert.equal(conf.bundle.macOS.signingIdentity, undefined, 'the identity comes from CI only, so local builds stay unsigned');
});

test('verify-desktop-signing.sh rejects a missing app before running any check', t => {
  const result = spawnSync('bash', [join(repo, 'scripts/release/verify-desktop-signing.sh'), join(tempDir(t), 'Exo.app'), 'Exo.dmg', 'ABCDE12345'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::no app bundle at/);
});
