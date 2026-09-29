#!/usr/bin/env node
/**
 * Release invariants. Fails when:
 *  - a release unit has no stable X.Y.Z version or is not private (Changesets silently skips unversioned packages);
 *  - any workspace package is not private (nothing in this repo may ever reach npm);
 *  - a pending changeset names anything other than the release units, or pre mode is on (stable only);
 *  - desktop/package.json, Cargo.toml and Cargo.lock disagree, or tauri.conf.json does not read package.json.
 * With --since <ref> (PR check) it also requires the branch to add at least one changeset.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DESKTOP, STABLE_VERSION, UNITS, readCargoLockVersion, readCargoTomlVersion, readJson, repoRoot } from './units.mjs';

const CHANGESET_FILE = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;
const RELEASE_LINE = /^(["']?)([^"'\s:]+)\1\s*:\s*(major|minor|patch|none)$/;

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

function parseChangeset(text) {
  const match = /^---\r?\n([\s\S]*?)^---\s*$/m.exec(text);
  if (!match || match.index !== 0) throw new Error('missing --- frontmatter');
  return match[1].split(/\r?\n/).filter(line => line.trim()).map(line => {
    const release = RELEASE_LINE.exec(line.trim());
    if (!release) throw new Error(`unparseable release line ${JSON.stringify(line)}`);
    return { name: release[2], type: release[3] };
  });
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.split('\n').filter(Boolean);
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

  for (const unit of UNITS) {
    const pkg = readJson(root, `${unit.dir}/package.json`);
    if (pkg.name !== unit.name) errors.push(`${unit.dir}/package.json must be named ${unit.name}, found ${JSON.stringify(pkg.name)}`);
    if (!STABLE_VERSION.test(pkg.version ?? '')) errors.push(`${unit.dir}/package.json needs a stable X.Y.Z "version" (Changesets silently skips unversioned packages), found ${JSON.stringify(pkg.version)}`);
  }

  if (existsSync(join(root, '.changeset/pre.json'))) errors.push('.changeset/pre.json exists: prerelease mode is not allowed (stable channel only)');
  const pending = new Map();
  for (const file of readdirSync(join(root, '.changeset')).map(name => `.changeset/${name}`).filter(file => CHANGESET_FILE.test(file))) {
    let releases;
    try {
      releases = parseChangeset(readFileSync(join(root, file), 'utf8'));
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
      continue;
    }
    pending.set(file, releases);
    for (const { name } of releases) {
      if (!unitNames.has(name)) errors.push(`${file} names ${name}; changesets may only name ${[...unitNames].join(', ')}`);
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
    const added = git(root, ['diff', '--name-only', '--diff-filter=A', `${since}...HEAD`]).filter(file => CHANGESET_FILE.test(file));
    if (added.length === 0) {
      errors.push(`No changeset added since ${since}. Every PR needs one: run \`bunx changeset\`, or \`bunx changeset add --empty\` if nothing ships.`);
    }
    const changed = git(root, ['diff', '--name-only', `${since}...HEAD`]);
    const namesDesktop = added.some(file => pending.get(file)?.some(release => release.name === 'exo-desktop'));
    if (!namesDesktop && changed.some(file => file.startsWith('frontend/src/'))) {
      notices.push('frontend/src changed without an exo-desktop changeset. The desktop app bundles the frontend; add one if desktop users should get this change.');
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
