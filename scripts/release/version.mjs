#!/usr/bin/env node
/**
 * Release-job versioning (js-sdk's Release model without npm). main stays in Changesets pre mode, tag "beta":
 *  - mode "pre" with new non-empty changesets: version betas (X.Y.Z-beta.N);
 *  - mode "exit" (the merged Release stable PR): version stable, then re-enter beta pre mode. check.mjs refuses this
 *    when a changeset no beta released yet exists or the PR's recorded plan is stale;
 *  - otherwise nothing (empty-only changesets wait for the next real one).
 * Refuses unconfirmed majors, syncs the desktop version, re-checks invariants and commits with [skip ci].
 * Writes channel=beta|stable|none to $GITHUB_OUTPUT.
 */
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PRE_TAG, STABLE_PLAN, changeset, git, readChangesets, readPreState, repoRoot, run, setOutput } from './lib.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' } } });
const root = resolve(values.root ?? repoRoot);
const here = dirname(fileURLToPath(import.meta.url));
const script = (name, args = []) => console.log(run(root, process.execPath, [join(here, name), '--root', root, ...args]));

if (git(root, ['status', '--porcelain'])) throw new Error('Refusing to version a dirty working tree');
script('check.mjs');
const pre = readPreState(root);
if (pre?.tag !== PRE_TAG || !['pre', 'exit'].includes(pre.mode)) {
  throw new Error(`main must be in Changesets pre mode (tag ${PRE_TAG}); .changeset/pre.json is ${JSON.stringify(pre)}`);
}

const fresh = readChangesets(root).filter(changeset => !changeset.admitted && changeset.releases?.length);
const channel = pre.mode === 'exit' ? 'stable' : fresh.length ? PRE_TAG : 'none';

if (channel === 'none') {
  console.log('No new changesets to release.');
} else {
  script('check-beta-release-plan.mjs');
  console.log(changeset(root, ['version']));
  if (channel === 'stable') rmSync(join(root, STABLE_PLAN));
  script('sync-desktop-version.mjs');
  if (channel === 'stable') console.log(changeset(root, ['pre', 'enter', PRE_TAG]));
  script('check.mjs');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', `chore(release): ${channel} versions [skip ci]`]);
  console.log(git(root, ['show', '--stat', '--format=%H %s', 'HEAD']));
}
setOutput('channel', channel);
