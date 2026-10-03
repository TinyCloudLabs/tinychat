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
export const FRONTEND = '@tinychat/frontend';
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
export const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
export const PRE_TAG = 'beta';
export const BRANCH_STABLE = 'release/stable';
// Cloudflare Pages builds this branch as production (tinycloud.chat); only deploy-production.yml advances it.
export const BRANCH_PRODUCTION = 'production';
export const PRODUCTION_WORKFLOW = 'deploy-production.yml';
export const DESKTOP_RELEASE_WORKFLOW = 'desktop-release.yml';

/** Split a `<name>@<version>` tag; names may be scoped (`@tinychat/backend@0.1.1`). */
export function parseTag(tag) {
  const at = tag.lastIndexOf('@');
  if (at <= 0 || at === tag.length - 1) throw new Error(`Not a <name>@<version> tag: ${JSON.stringify(tag)}`);
  return { name: tag.slice(0, at), version: tag.slice(at + 1) };
}

/**
 * The workflows the Release job starts for the tags one run created (tags pushed with GITHUB_TOKEN trigger
 * nothing; workflow_dispatch is the one event that token may start). Returns [{ workflow, ref, inputs, tags }].
 *  - every new exo-desktop tag of a "beta" or "stable" run: one desktop release build, dispatched on main with the tag
 *    as an input (a GitHub pre-release for a beta, a published Release for stable);
 *  - channel "stable": one production deploy on the stable version commit, backend first, then web, for the units
 *    that got a new stable tag;
 *  - channel "beta": no production deploy. Betas never deploy web or backend;
 *  - channel "none" (the 0.1.0 baseline tags of the first run): nothing.
 */
export function planDispatches({ channel, tags }) {
  if (!['beta', 'stable', 'none'].includes(channel)) throw new Error(`Unknown release channel ${JSON.stringify(channel)}`);
  const parsed = tags.map(tag => ({ tag, ...parseTag(tag) }));
  const dispatches = [];
  const releaseVersion = channel === 'stable' ? STABLE_VERSION : /^\d+\.\d+\.\d+-beta\.\d+$/;
  if (channel !== 'none') {
    // Always run from main (trusted workflow code); the tag is an input the workflow validates.
    for (const { tag } of parsed.filter(tag => tag.name === DESKTOP.crate && releaseVersion.test(tag.version))) {
      dispatches.push({ workflow: DESKTOP_RELEASE_WORKFLOW, ref: 'main', inputs: { tag }, tags: [tag] });
    }
  }
  if (channel === 'stable') {
    const stable = name => parsed.find(tag => tag.name === name && STABLE_VERSION.test(tag.version));
    const backend = stable(BACKEND);
    const web = stable(FRONTEND);
    if (backend || web) {
      dispatches.push({
        workflow: PRODUCTION_WORKFLOW,
        // Always from main (trusted workflow code); the tag selects the commit. Every stable tag of a run sits on the
        // same stable version commit; dispatch.mjs verifies that.
        ref: 'main',
        inputs: { tag: (backend ?? web).tag, backend: String(Boolean(backend)), web: String(Boolean(web)) },
        tags: [backend, web].filter(Boolean).map(({ tag }) => tag),
      });
    }
  }
  return dispatches;
}

const PAGES_CHECK = 'Cloudflare Pages';
const PAGES_APP = 'cloudflare-workers-and-pages';

/**
 * Classify the Cloudflare Pages check runs GitHub lists for a production-branch commit:
 *  - waiting: no finished run from the Pages app yet;
 *  - failed: the newest run did not succeed;
 *  - preview: it succeeded but as a preview (its summary has a "Branch Preview URL"), so the Pages project's
 *    production branch is not `production`;
 *  - production: it succeeded as a production deployment; `deploymentUrl` is that deployment's unique URL.
 */
export function classifyPagesCheckRuns(checkRuns) {
  const runs = checkRuns
    .filter(run => run.name === PAGES_CHECK && run.app?.slug === PAGES_APP)
    .sort((a, b) => b.id - a.id);
  const [latest] = runs;
  if (!latest || latest.status !== 'completed') return { state: 'waiting' };
  const summary = latest.output?.summary ?? '';
  if (latest.conclusion !== 'success') return { state: 'failed', reason: `${latest.conclusion}: ${latest.output?.title ?? ''}`.trim(), detailsUrl: latest.details_url };
  if (/Branch Preview URL/.test(summary)) return { state: 'preview', detailsUrl: latest.details_url };
  const deploymentUrl = /Preview URL:[\s\S]*?href='(https:\/\/[^']+)'/.exec(summary)?.[1];
  if (!deploymentUrl) return { state: 'failed', reason: 'no deployment URL in the Cloudflare Pages check run', detailsUrl: latest.details_url };
  return { state: 'production', deploymentUrl, detailsUrl: latest.details_url };
}

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

/**
 * Apple's Info.plist versions for an Exo semver (desktop/package.json). CFBundleShortVersionString must be numeric
 * X.Y.Z, so a beta X.Y.Z-beta.N uses the X.Y.Z it leads to. CFBundleVersion is one integer XYYZZSSS
 * (X, two-digit Y, two-digit Z, three-digit stage), where the stage is N for beta.N and 999 for stable. It increases
 * with every beta and stable release (0.2.0-beta.3 -> 200003 < 0.2.0 -> 200999 < 0.2.1-beta.0 -> 201000) and stays
 * below 2^31. The semver itself stays in the app (tauri's version), the tag, the DMG name and the release title.
 */
export function desktopBundleVersions(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version ?? '');
  if (!match) throw new Error(`Exo version must be X.Y.Z or X.Y.Z-beta.N, got ${JSON.stringify(version)}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const beta = match[4] === undefined ? undefined : Number(match[4]);
  if (major > 213 || minor > 99 || patch > 99 || beta > 998) {
    throw new Error(`${version} does not fit the CFBundleVersion scheme XYYZZSSS (X <= 213, Y and Z <= 99, beta <= 998): extend desktopBundleVersions`);
  }
  return {
    shortVersion: `${major}.${minor}.${patch}`,
    bundleVersion: String(((major * 100 + minor) * 100 + patch) * 1000 + (beta ?? 999)),
    prerelease: beta !== undefined,
  };
}

/** The body of the `## <version>` section of a Changesets CHANGELOG.md, or '' when absent or "No changes". */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `## ${version}`);
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
  return body === 'No changes in this release.' ? '' : body;
}
