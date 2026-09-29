#!/usr/bin/env node
/**
 * Tag each release unit's current version as <name>@<version> (beta or stable) on the first-parent commit that set
 * that version, never a later HEAD. Existing tags are left alone, but one that points anywhere else fails loudly.
 * Creates annotated tags locally and writes the new ones to $GITHUB_OUTPUT as `tags` (space-separated); the workflow
 * pushes them. This never publishes anything.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { UNITS, VERSION, git, repoRoot, setOutput } from './lib.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' } } });
const root = resolve(values.root ?? repoRoot);

function versionAt(commit, dir) {
  const text = git(root, ['show', `${commit}:${dir}/package.json`], { allowFailure: true });
  return text === undefined ? undefined : JSON.parse(text).version;
}

// Newest first-parent commit whose own version is `version` and whose first parent's is not.
function commitThatSet(dir, version) {
  const commits = git(root, ['log', '--first-parent', '--format=%H', 'HEAD', '--', `${dir}/package.json`]).split('\n').filter(Boolean);
  for (const commit of commits) {
    if (versionAt(commit, dir) !== version) continue;
    const parent = git(root, ['rev-parse', '--verify', '-q', `${commit}^1`], { allowFailure: true });
    if (parent === undefined || versionAt(parent, dir) !== version) return commit;
  }
  throw new Error(`No first-parent commit on HEAD sets ${dir}/package.json to ${version}`);
}

const missing = [];
for (const unit of UNITS) {
  const version = versionAt('HEAD', unit.dir);
  if (!VERSION.test(version ?? '')) throw new Error(`${unit.dir}/package.json needs an X.Y.Z or X.Y.Z-beta.N version, found ${JSON.stringify(version)}`);
  const tag = `${unit.name}@${version}`;
  const commit = commitThatSet(unit.dir, version);
  const existing = git(root, ['rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`], { allowFailure: true });
  if (existing === undefined) missing.push({ tag, commit });
  else if (existing === commit) console.log(`${tag} already tagged at ${commit}`);
  else throw new Error(`Tag ${tag} points at ${existing}, but ${commit} is the commit that set ${unit.dir}/package.json to ${version}`);
}

for (const { tag, commit } of missing) {
  git(root, ['tag', '-a', tag, '-m', tag, commit]);
  console.log(`tagged ${tag} at ${commit}`);
}
setOutput('tags', missing.map(({ tag }) => tag).join(' '));
