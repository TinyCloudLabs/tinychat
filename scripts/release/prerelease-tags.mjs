/**
 * Beta numbers that a tag already holds (TC-2189). `changeset version` numbers the next beta from package.json, so a
 * beta tag left behind on another commit (a release that never published) would make the Tag step fail every run.
 * A computed beta whose tag exists locally, at a commit other than the one about to be created, moves to the next
 * free beta number, but only when GitHub confirms no Release exists for that tag (a 404). A tag with a Release, a stable
 * tag on another commit, and any lookup that is not a confirmed 200 or 404 stop the release.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXED, UNITS, git, readJson } from './lib.mjs';

const BETA = /^(\d+\.\d+\.\d+)-beta\.(\d+)$/;
const MAX_ADVANCE = 1000;
const LOOKUP_TIMEOUT_MS = 15_000;

const tagFor = (unit, version) => `${unit.name}@${version}`;
const tagCommit = (root, tag) => git(root, ['rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`], { allowFailure: true });

/** True when GitHub has a Release for `tag`, false on a 404. Anything else cannot be trusted and throws. */
export async function githubReleaseExists(tag, env = process.env) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const cannot = reason => new Error(`Could not confirm whether GitHub has a Release for ${tag}: ${reason}`);
  if (!token || !repository) throw cannot('GH_TOKEN and GITHUB_REPOSITORY are required');
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  // The whole tag is one route parameter, so a scoped tag's slash is sent as %2F.
  const path = encodeURIComponent(tag);
  let response;
  try {
    response = await fetch(`${api}/repos/${repository}/releases/tags/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    throw cannot(error.message);
  }
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw cannot(`GitHub answered HTTP ${response.status}`);
}

/** Whether `version` of `unit` is free to tag: no local tag, or a local tag GitHub confirms was never released. */
async function tagIsFree(root, unit, version, lookup) {
  const tag = tagFor(unit, version);
  const existing = tagCommit(root, tag);
  if (existing === undefined) return true;
  if (BETA.test(version) === false) throw new Error(`Tag ${tag} already points at ${existing}, not at the stable version commit about to be created`);
  if (await lookup(tag)) throw new Error(`Tag ${tag} points at ${existing} and has a GitHub Release, so ${version} cannot be reused`);
  return false;
}

function setVersion(root, unit, from, to) {
  const manifest = join(root, unit.dir, 'package.json');
  const text = readFileSync(manifest, 'utf8');
  const next = text.replace(`"version": "${from}"`, `"version": "${to}"`);
  if (next === text) throw new Error(`${unit.dir}/package.json does not carry version ${from}`);
  writeFileSync(manifest, next);
  const changelog = join(root, unit.dir, 'CHANGELOG.md');
  if (existsSync(changelog)) {
    const log = readFileSync(changelog, 'utf8');
    const heading = new RegExp(`^## ${from.replaceAll('.', '\\.')}$`, 'm');
    if (heading.test(log)) writeFileSync(changelog, log.replace(heading, `## ${to}`));
  }
}

/**
 * Run after `changeset version`: `before` maps each unit's name to the version it had. Units whose version changed
 * are checked against the tags. Web and desktop share one number, so one collision moves both. Other units move alone.
 * Rewrites package.json and CHANGELOG.md; the caller syncs the desktop Cargo files afterwards.
 */
export async function resolvePrereleaseTags(root, before, { lookup = githubReleaseExists } = {}) {
  const changed = UNITS.filter(unit => readJson(root, `${unit.dir}/package.json`).version !== before[unit.name]);
  const groups = [
    changed.filter(unit => FIXED.includes(unit.name)),
    ...changed.filter(unit => !FIXED.includes(unit.name)).map(unit => [unit]),
  ].filter(group => group.length > 0);

  for (const group of groups) {
    const first = readJson(root, `${group[0].dir}/package.json`).version;
    const beta = BETA.exec(first);
    for (let advance = 0; ; advance++) {
      const number = beta === null ? undefined : Number(beta[2]) + advance;
      const version = beta === null ? first : `${beta[1]}-beta.${number}`;
      const free = [];
      for (const unit of group) free.push(await tagIsFree(root, unit, version, lookup));
      if (free.every(Boolean)) {
        if (advance > 0) {
          for (const unit of group) setVersion(root, unit, first, version);
          console.log(`${group.map(unit => unit.name).join(', ')}: ${first} was taken by an unpublished tag, using ${version}`);
        }
        break;
      }
      if (advance >= MAX_ADVANCE) throw new Error(`No free beta number after ${first} for ${group.map(unit => unit.name).join(', ')}`);
    }
  }
}
