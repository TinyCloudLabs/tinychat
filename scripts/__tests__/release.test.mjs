import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
function manifests(t) {
  const root = tempDir(t);
  for (const rel of MANIFESTS) write(root, rel, read(repo, rel));
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
  assert.match(step('stable-pr.mjs', ['--body', body]), /^open=false$/m);

  // The next change starts a new beta cycle from the stable versions.
  write(root, '.changeset/next.md', changesetFile({ '@tinychat/backend': 'minor' }, 'Next API'));
  commitAll(root, 'feat: next api (#6)');
  assert.match(step('version.mjs'), /^channel=beta$/m);
  assert.deepEqual(versions(), ['0.2.0', '0.2.0', '0.2.0-beta.0']);
});
