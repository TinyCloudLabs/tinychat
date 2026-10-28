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
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BACKEND, PRE_TAG, STABLE_PLAN, STABLE_SCOPE_FRONTEND_DESKTOP, changeset, git, readChangesets, readJson, readPreState,
  repoRoot, run, setOutput, withIgnoredPackages,
} from './lib.mjs';

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
const scopedPlan = channel === 'stable' ? readJson(root, STABLE_PLAN) : undefined;

if (channel === 'none') {
  console.log('No new changesets to release.');
} else {
  script('check-beta-release-plan.mjs');
  const scoped = scopedPlan?.scope === STABLE_SCOPE_FRONTEND_DESKTOP;
  const backendBefore = scoped ? readJson(root, 'backend/package.json').version : undefined;
  if (scoped) {
    writeFileSync(join(root, '.changeset/pre.json'), `${JSON.stringify({ mode: pre.mode, tag: pre.tag }, null, 2)}\n`);
  }
  const versionPackages = () => changeset(root, ['version']);
  console.log(scoped ? withIgnoredPackages(root, [BACKEND], versionPackages) : versionPackages());
  if (scoped) {
    const backendVersion = readJson(root, 'backend/package.json').version;
    const expectedBackendVersion = scopedPlan.pending.versions[BACKEND] ?? backendBefore;
    if (backendVersion !== expectedBackendVersion) {
      throw new Error(`Scoped stable promotion changed backend ${BACKEND} from its pending version ${expectedBackendVersion} to ${backendVersion}`);
    }
    const admitted = new Set(readChangesets(root).filter(changeset => changeset.admitted).map(changeset => changeset.file));
    const missing = scopedPlan.pending.changesets.filter(file => !admitted.has(file));
    if (missing.length) throw new Error(`Scoped stable promotion consumed pending backend changesets: ${missing.join(', ')}`);
  }
  if (channel === 'stable') rmSync(join(root, STABLE_PLAN));
  script('sync-desktop-version.mjs');
  if (channel === 'stable') console.log(changeset(root, ['pre', 'enter', PRE_TAG]));
  script('check.mjs');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', `chore(release): ${channel} versions [skip ci]`]);
  console.log(git(root, ['show', '--stat', '--format=%H %s', 'HEAD']));
}
setOutput('channel', channel);
