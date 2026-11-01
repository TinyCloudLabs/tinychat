/**
 * Beta numbers that a tag already holds (TC-2189). `changeset version` numbers the next beta from package.json, so a
 * beta tag left behind on another commit (a release that never published) would make the Tag step fail every run.
 * A computed beta whose tag exists locally, at a commit other than the one about to be created, moves to the next
 * free beta number, but only when GitHub confirms no Release (draft or published) exists for that tag. A tag with a Release, a stable
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

const MAX_LIST_PAGES = 500;

/**
 * True when GitHub has a Release for `tag`, false when it confirms there is none. The by-tag endpoint only answers for
 * published Releases (a draft is a 404 there), so a 404 is followed by a read of the whole Releases list, drafts
 * included. Any answer that cannot be trusted (an error status, a malformed page, an unreachable API) throws.
 */
export async function githubReleaseExists(tag, env = process.env) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const cannot = reason => new Error(`Could not confirm whether GitHub has a Release for ${tag}: ${reason}`);
  if (!token || !repository) throw cannot('GH_TOKEN and GITHUB_REPOSITORY are required');
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const get = async url => {
    try {
      return await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
    } catch (error) {
      throw cannot(error.message);
    }
  };

  // The whole tag is one route parameter, so a scoped tag's slash is sent as %2F.
  const byTag = await get(`${api}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
  if (byTag.status === 200) return true;
  if (byTag.status !== 404) throw cannot(`GitHub answered HTTP ${byTag.status}`);

  let next = `${api}/repos/${repository}/releases?per_page=100`;
  for (let page = 1; next !== undefined; page++) {
    if (page > MAX_LIST_PAGES) throw cannot(`the Releases list has more than ${MAX_LIST_PAGES} pages`);
    const response = await get(next);
    if (response.status !== 200) throw cannot(`GitHub answered HTTP ${response.status} for the Releases list`);
    let releases;
    try {
      releases = await response.json();
    } catch {
      throw cannot('the Releases list is not JSON');
    }
    if (!Array.isArray(releases)) throw cannot('the Releases list is not an array');
    if (releases.some(release => release?.tag_name === tag)) return true;
    const link = /<([^>]+)>\s*;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
    if (link !== undefined && new URL(link).origin !== new URL(api).origin) throw cannot('the Releases list links to another host');
    next = link;
  }
  return false;
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
