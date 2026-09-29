#!/usr/bin/env node
/**
 * Tag each release unit's current version as <name>@<version> on the first-parent commit that set that version
 * (the Version PR merge or squash commit, never a later HEAD), then push the new tags. Existing tags are left alone,
 * but one that points anywhere else fails loudly. This never publishes anything.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { STABLE_VERSION, UNITS, repoRoot } from './units.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, remote: { type: 'string', default: 'origin' } } });
const root = resolve(values.root ?? repoRoot);

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function versionAt(commit, dir) {
  const text = git(['show', `${commit}:${dir}/package.json`], { allowFailure: true });
  return text === undefined ? undefined : JSON.parse(text).version;
}

// Newest first-parent commit whose own version is `version` and whose first parent's is not.
function commitThatSet(dir, version) {
  const commits = git(['log', '--first-parent', '--format=%H', 'HEAD', '--', `${dir}/package.json`]).split('\n').filter(Boolean);
  for (const commit of commits) {
    if (versionAt(commit, dir) !== version) continue;
    const parent = git(['rev-parse', '--verify', '-q', `${commit}^1`], { allowFailure: true });
    if (parent === undefined || versionAt(parent, dir) !== version) return commit;
  }
  throw new Error(`No first-parent commit on HEAD sets ${dir}/package.json to ${version}`);
}

const missing = [];
for (const unit of UNITS) {
  const version = versionAt('HEAD', unit.dir);
  if (!STABLE_VERSION.test(version ?? '')) throw new Error(`${unit.dir}/package.json needs a stable X.Y.Z version, found ${JSON.stringify(version)}`);
  const tag = `${unit.name}@${version}`;
  const commit = commitThatSet(unit.dir, version);
  const existing = git(['rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`], { allowFailure: true });
  if (existing === undefined) missing.push({ tag, commit });
  else if (existing === commit) console.log(`${tag} already tagged at ${commit}`);
  else throw new Error(`Tag ${tag} points at ${existing}, but ${commit} is the commit that set ${unit.dir}/package.json to ${version}`);
}

for (const { tag, commit } of missing) {
  git(['tag', '-a', tag, '-m', tag, commit]);
  console.log(`tagged ${tag} at ${commit}`);
}
if (missing.length) {
  git(['push', '--atomic', values.remote, ...missing.map(({ tag }) => `refs/tags/${tag}`)]);
  console.log(`pushed ${missing.map(({ tag }) => tag).join(' ')} to ${values.remote}`);
}
