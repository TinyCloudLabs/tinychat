/** Shared release definitions. Every workspace package other than the release units is private and ignored by Changesets. */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const UNITS = [
  { name: 'exo-desktop', dir: 'desktop' },
  { name: '@tinychat/frontend', dir: 'frontend' },
  { name: '@tinychat/backend', dir: 'backend' },
];
export const BACKEND = '@tinychat/backend';
// One product version for web and desktop (and future mobile): a Changesets `fixed` group.
export const FIXED = ['@tinychat/frontend', 'exo-desktop'];

export const DESKTOP = {
  packageJson: 'desktop/package.json',
  tauriConf: 'desktop/src-tauri/tauri.conf.json',
  cargoToml: 'desktop/src-tauri/Cargo.toml',
  cargoLock: 'desktop/src-tauri/Cargo.lock',
  crate: 'exo-desktop',
};

// Stable X.Y.Z, or X.Y.Z-beta.N while main is in Changesets pre mode (tag "beta").
export const VERSION = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
export const PRE_TAG = 'beta';
export const BRANCH_STABLE = 'release/stable';

export const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

export function readPreState(root) {
  const path = join(root, '.changeset/pre.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

const RELEASE_LINE = /^(["']?)([^"'\s:]+)\1\s*:\s*(major|minor|patch|none)$/;

export function parseChangeset(text) {
  const match = /^---\r?\n([\s\S]*?)^---\s*$/m.exec(text);
  if (!match || match.index !== 0) throw new Error('missing --- frontmatter');
  return match[1].split(/\r?\n/).filter(line => line.trim()).map(line => {
    const release = RELEASE_LINE.exec(line.trim());
    if (!release) throw new Error(`unparseable release line ${JSON.stringify(line)}`);
    return { name: release[2], type: release[3] };
  });
}

const isChangesetFile = name => name.endsWith('.md') && name !== 'README.md';

/**
 * Pending changesets. Changesets v3 moves the ones a beta already released into .changeset/pre/ ("admitted");
 * new ones sit in .changeset/. A file that fails to parse is returned with `error` instead of `releases`.
 */
export function readChangesets(root) {
  const list = (rel, admitted) => existsSync(join(root, rel))
    ? readdirSync(join(root, rel)).filter(isChangesetFile).sort().map(name => ({ file: `${rel}/${name}`, admitted }))
    : [];
  return [...list('.changeset', false), ...list('.changeset/pre', true)].map(changeset => {
    try {
      return { ...changeset, releases: parseChangeset(readFileSync(join(root, changeset.file), 'utf8')) };
    } catch (error) {
      return { ...changeset, error: error.message };
    }
  });
}

// The Release stable PR records the plan it was reviewed with here; the stable release deletes it.
export const STABLE_PLAN = '.changeset/release-stable.json';

/**
 * What a stable release ships right now: every unit on a beta graduates to its X.Y.Z, carrying the changesets that
 * betas already released (.changeset/pre/). Fresh changesets never go straight to stable (check.mjs refuses them).
 */
export function stablePlan(root) {
  const versions = {};
  for (const unit of UNITS) {
    const beta = /^(\d+\.\d+\.\d+)-beta\.\d+$/.exec(readJson(root, `${unit.dir}/package.json`).version ?? '');
    if (beta) versions[unit.name] = beta[1];
  }
  return { versions, changesets: readChangesets(root).filter(changeset => changeset.admitted).map(changeset => changeset.file) };
}

const canonicalPlan = plan => JSON.stringify({ versions: Object.entries(plan.versions).sort(), changesets: [...plan.changesets].sort() });
export const samePlan = (a, b) => canonicalPlan(a) === canonicalPlan(b);

// `version = "..."` inside the [package] table of Cargo.toml.
const cargoTomlVersion = /^(\[package\]\n(?:(?!\[)[^\n]*\n)*?version = ")([^"\n]*)(")/m;

// The `[[package]] name = "<crate>" version = "..."` entry in Cargo.lock.
const cargoLockVersion = crate => new RegExp(`^(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")([^"\\n]*)(")`, 'gm');

function single(text, regex, what) {
  const matches = [...text.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`))];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${what}, found ${matches.length}`);
  return matches[0][2];
}

export const readCargoTomlVersion = text => single(text, cargoTomlVersion, '[package] version in Cargo.toml');
export const readCargoLockVersion = text => single(text, cargoLockVersion(DESKTOP.crate), `${DESKTOP.crate} entry in Cargo.lock`);

export function setCargoTomlVersion(text, version) {
  readCargoTomlVersion(text);
  return text.replace(cargoTomlVersion, `$1${version}$3`);
}

export function setCargoLockVersion(text, version) {
  readCargoLockVersion(text);
  return text.replace(cargoLockVersion(DESKTOP.crate), `$1${version}$3`);
}

export function run(root, command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: process.env });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}${result.stderr}`);
  }
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export const git = (root, args, options) => run(root, 'git', args, options);

// The Changesets CLI installed in `root` (never a globally installed or downloaded one).
export function changeset(root, args) {
  const bin = createRequire(join(root, 'package.json')).resolve('@changesets/cli/bin.js');
  return run(root, process.execPath, [bin, ...args]);
}

export function setOutput(name, value) {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
