#!/usr/bin/env node
/**
 * Release invariants. Fails when:
 *  - any workspace package is not private (nothing in this repo may ever reach npm);
 *  - a release unit has no X.Y.Z / X.Y.Z-beta.N version (Changesets silently skips unversioned packages);
 *  - web and desktop versions differ (one fixed group), or the backend leaves 0.x;
 *  - .changeset/pre.json is {"mode": "pre" | "exit", "tag": "beta"}, optionally with the reviewed frontend-desktop stable scope;
 *  - in "exit" mode (the merged Release stable PR): a changeset no beta has released yet exists, or the plan recorded in
 *    .changeset/release-stable.json is not what a stable release would ship now (the PR went stale);
 *  - a changeset names anything other than the release units, or bumps the backend `major`;
 *  - desktop/package.json, Cargo.toml and Cargo.lock disagree, or tauri.conf.json does not read package.json.
 * With --since <ref> (PR check) it also requires the branch to add a changeset, except for the Release stable PR,
 * whose only changes are .changeset/pre.json -> "exit" and its recorded plan.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BACKEND, DESKTOP, FIXED, PRE_TAG, STABLE_PLAN, STABLE_SCOPE_FRONTEND_DESKTOP, UNITS, VERSION, git, readCargoLockVersion, readCargoTomlVersion,
  readChangesets, readJson, readPreState, repoRoot, samePlan, stablePlan,
} from './lib.mjs';

function workspaceDirs(root) {
  const dirs = [];
  for (const pattern of readJson(root, 'package.json').workspaces ?? []) {
    if (pattern.endsWith('/*') && !pattern.slice(0, -2).includes('*')) {
      const parent = pattern.slice(0, -2);
      for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(root, parent, entry.name, 'package.json'))) dirs.push(`${parent}/${entry.name}`);
      }
    } else if (!/[*?[{]/.test(pattern)) {
      dirs.push(pattern);
    } else {
      throw new Error(`Unsupported workspace pattern ${JSON.stringify(pattern)}: extend scripts/release/check.mjs`);
    }
  }
  return dirs;
}

function checkRelease(root, { since } = {}) {
  const errors = [];
  const notices = [];
  const unitNames = new Set(UNITS.map(unit => unit.name));

  if (readJson(root, 'package.json').private !== true) errors.push('root package.json must be "private": true');
  for (const dir of workspaceDirs(root)) {
    const pkg = readJson(root, `${dir}/package.json`);
    if (pkg.private !== true) errors.push(`${dir}/package.json (${pkg.name}) must be "private": true so it can never be published to npm`);
  }

  const versions = new Map();
  for (const unit of UNITS) {
    const pkg = readJson(root, `${unit.dir}/package.json`);
    if (pkg.name !== unit.name) errors.push(`${unit.dir}/package.json must be named ${unit.name}, found ${JSON.stringify(pkg.name)}`);
    if (!VERSION.test(pkg.version ?? '')) errors.push(`${unit.dir}/package.json needs an X.Y.Z or X.Y.Z-beta.N "version" (Changesets silently skips unversioned packages), found ${JSON.stringify(pkg.version)}`);
    versions.set(unit.name, pkg.version);
  }
  if (new Set(FIXED.map(name => versions.get(name))).size !== 1) {
    errors.push(`${FIXED.join(' and ')} share one version (Changesets fixed group), found ${FIXED.map(name => `${name}@${versions.get(name)}`).join(', ')}`);
  }
  if (!/^0\./.test(versions.get(BACKEND) ?? '')) errors.push(`${BACKEND} stays on 0.x, found ${versions.get(BACKEND)}`);

  const restoreBeta = `restore it to {"mode": "pre", "tag": "${PRE_TAG}"} (\`bunx changeset pre enter ${PRE_TAG}\`)`;
  let pre;
  if (!existsSync(join(root, '.changeset/pre.json'))) {
    errors.push(`.changeset/pre.json is missing: main must stay in Changesets pre mode; ${restoreBeta}`);
  } else {
    try {
      pre = readPreState(root);
      const expectedKeys = pre?.stableScope === undefined ? 'mode,tag' : 'mode,stableScope,tag';
      if (pre === null || typeof pre !== 'object' || Array.isArray(pre) || Object.keys(pre).sort().join() !== expectedKeys
        || pre.tag !== PRE_TAG || !['pre', 'exit'].includes(pre.mode)
        || (pre.stableScope !== undefined && pre.stableScope !== STABLE_SCOPE_FRONTEND_DESKTOP)) {
        errors.push(`.changeset/pre.json must be {"mode": "pre" | "exit", "tag": "${PRE_TAG}"}, optionally with "stableScope": "${STABLE_SCOPE_FRONTEND_DESKTOP}", found ${JSON.stringify(pre)}; ${restoreBeta}`);
      }
    } catch (error) {
      errors.push(`.changeset/pre.json is not valid JSON (${error.message}); ${restoreBeta}`);
    }
  }

  const changesets = readChangesets(root);
  for (const { file, error, releases } of changesets) {
    if (error) {
      errors.push(`${file}: ${error}`);
      continue;
    }
    for (const { name, type } of releases) {
      if (!unitNames.has(name)) errors.push(`${file} names ${name}; changesets may only name ${[...unitNames].join(', ')}`);
      if (name === BACKEND && type === 'major') errors.push(`${file} bumps ${BACKEND} major; the backend stays on 0.x and takes only minor or patch`);
    }
  }

  const hasPlan = existsSync(join(root, STABLE_PLAN));
  const recorded = hasPlan ? readRecordedPlan(root, errors) : undefined;
  if (pre?.mode === 'exit') {
    const recover = `If the Release stable PR is already merged, open a PR that sets .changeset/pre.json back to {"mode": "pre", "tag": "${PRE_TAG}"} (\`bunx changeset pre enter ${PRE_TAG}\`), deletes ${STABLE_PLAN} and adds an empty changeset; otherwise wait for the Release workflow to refresh the PR (it does after every push to main).`;
    const fresh = changesets.filter(changeset => !changeset.admitted && changeset.releases?.length).map(changeset => changeset.file);
    if (fresh.length) {
      errors.push(`Stable releases only ship what a beta already released, but no beta has released ${fresh.join(', ')} yet. ${recover}`);
    }
    if (!hasPlan) {
      errors.push(`.changeset/pre.json is in "exit" mode without ${STABLE_PLAN}: only merge the Release stable PR that the Release workflow maintains.`);
    } else if (recorded && (recorded.scope !== pre?.stableScope || !samePlan(recorded, stablePlan(root, recorded.scope)))) {
      errors.push(`The Release stable PR is stale: it was reviewed as ${JSON.stringify(recorded)}, but a stable release would now ship ${JSON.stringify(stablePlan(root, recorded.scope))}. ${recover}`);
    }
  } else if (hasPlan) {
    errors.push(`${STABLE_PLAN} only belongs to the Release stable PR ("exit" mode); delete it.`);
  }

  const desktopVersion = readJson(root, DESKTOP.packageJson).version;
  const tauriVersion = readJson(root, DESKTOP.tauriConf).version;
  if (tauriVersion !== '../package.json') errors.push(`${DESKTOP.tauriConf} "version" must be "../package.json", found ${JSON.stringify(tauriVersion)}`);
  for (const [rel, read] of [[DESKTOP.cargoToml, readCargoTomlVersion], [DESKTOP.cargoLock, readCargoLockVersion]]) {
    let version;
    try {
      version = read(readFileSync(join(root, rel), 'utf8'));
    } catch (error) {
      errors.push(`${rel}: ${error.message}`);
      continue;
    }
    if (version !== desktopVersion) errors.push(`${rel} has ${DESKTOP.crate} ${version} but ${DESKTOP.packageJson} has ${desktopVersion}: run node scripts/release/sync-desktop-version.mjs`);
  }

  if (since) {
    const changed = git(root, ['diff', '--name-only', `${since}...HEAD`]).split('\n').filter(Boolean);
    const added = git(root, ['diff', '--name-only', '--diff-filter=A', `${since}...HEAD`]).split('\n')
      .filter(file => /^\.changeset\/(?!README\.md$)[^/]+\.md$/.test(file));
    const releaseStablePr = pre?.mode === 'exit' && changed.length > 0
      && changed.every(file => file === '.changeset/pre.json' || file === STABLE_PLAN);
    if (added.length === 0 && !releaseStablePr) {
      errors.push(`No changeset added since ${since}. Every PR needs one: run \`bunx changeset\`, or \`bunx changeset add --empty\` if nothing ships.`);
    }
    const majors = changesets.filter(({ file }) => added.includes(file))
      .flatMap(({ releases = [] }) => releases.filter(release => release.type === 'major' && release.name !== BACKEND));
    if (majors.length) {
      notices.push(`Major bump for ${[...new Set(majors.map(release => release.name))].join(', ')}: after merge the Release workflow refuses it until someone runs it with confirm=major-beta.`);
    }
  }

  return { errors, notices };
}

function readRecordedPlan(root, errors) {
  let plan;
  try {
    plan = readJson(root, STABLE_PLAN);
  } catch (error) {
    errors.push(`${STABLE_PLAN} is not valid JSON: ${error.message}`);
    return undefined;
  }
  const units = new Set(UNITS.map(unit => unit.name));
  const keys = Object.keys(plan ?? {}).sort().join();
  const scoped = keys === 'changesets,pending,scope,versions';
  const pendingValid = !scoped || (plan.scope === STABLE_SCOPE_FRONTEND_DESKTOP
    && plan.pending !== null && typeof plan.pending === 'object' && !Array.isArray(plan.pending)
    && Object.keys(plan.pending).sort().join() === 'changesets,versions'
    && plan.pending.versions !== null && typeof plan.pending.versions === 'object' && !Array.isArray(plan.pending.versions)
    && Object.entries(plan.pending.versions).every(([name, version]) => units.has(name) && VERSION.test(version))
    && Array.isArray(plan.pending.changesets) && plan.pending.changesets.every(file => typeof file === 'string'));
  const valid = plan !== null && typeof plan === 'object' && !Array.isArray(plan)
    && (keys === 'changesets,versions' || scoped)
    && plan.versions !== null && typeof plan.versions === 'object' && !Array.isArray(plan.versions)
    && Object.entries(plan.versions).every(([name, version]) => units.has(name) && /^\d+\.\d+\.\d+$/.test(version))
    && Array.isArray(plan.changesets) && plan.changesets.every(file => typeof file === 'string')
    && pendingValid;
  if (!valid) {
    errors.push(`${STABLE_PLAN} must be a full stable plan {"versions": {"<unit>": "X.Y.Z"}, "changesets": ["<file>"]} or a scoped plan with "scope", "pending", "versions", and "changesets"; found ${JSON.stringify(plan)}`);
    return undefined;
  }
  return plan;
}

const { values } = parseArgs({ options: { root: { type: 'string' }, since: { type: 'string' } } });
const { errors, notices } = checkRelease(resolve(values.root ?? repoRoot), { since: values.since });
const annotate = process.env.GITHUB_ACTIONS === 'true';
for (const notice of notices) console.log(annotate ? `::notice::${notice}` : `notice: ${notice}`);
for (const error of errors) console.error(annotate ? `::error::${error}` : `error: ${error}`);
if (errors.length) process.exit(1);
console.log('release check passed');
