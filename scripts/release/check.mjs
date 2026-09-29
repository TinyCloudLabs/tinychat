#!/usr/bin/env node
/**
 * Release invariants. Fails when:
 *  - any workspace package is not private (nothing in this repo may ever reach npm);
 *  - a release unit has no X.Y.Z / X.Y.Z-beta.N version (Changesets silently skips unversioned packages);
 *  - web and desktop versions differ (one fixed group), or the backend leaves 0.x;
 *  - .changeset/pre.json is not beta pre mode (or its "exit" for a stable release);
 *  - a changeset names anything other than the release units, or bumps the backend `major`;
 *  - desktop/package.json, Cargo.toml and Cargo.lock disagree, or tauri.conf.json does not read package.json.
 * With --since <ref> (PR check) it also requires the branch to add a changeset, except for the Release stable PR,
 * whose only change is flipping .changeset/pre.json to "exit".
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BACKEND, DESKTOP, FIXED, PRE_TAG, UNITS, VERSION, git, readCargoLockVersion, readCargoTomlVersion, readChangesets,
  readJson, readPreState, repoRoot,
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

  const pre = readPreState(root);
  if (pre && (pre.tag !== PRE_TAG || !['pre', 'exit'].includes(pre.mode))) {
    errors.push(`.changeset/pre.json must be {"mode": "pre" | "exit", "tag": "${PRE_TAG}"}, found ${JSON.stringify(pre)}`);
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
    const releaseStablePr = changed.length === 1 && changed[0] === '.changeset/pre.json' && pre?.mode === 'exit';
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

const { values } = parseArgs({ options: { root: { type: 'string' }, since: { type: 'string' } } });
const { errors, notices } = checkRelease(resolve(values.root ?? repoRoot), { since: values.since });
const annotate = process.env.GITHUB_ACTIONS === 'true';
for (const notice of notices) console.log(annotate ? `::notice::${notice}` : `notice: ${notice}`);
for (const error of errors) console.error(annotate ? `::error::${error}` : `error: ${error}`);
if (errors.length) process.exit(1);
console.log('release check passed');
