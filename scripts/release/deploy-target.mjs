#!/usr/bin/env node
/**
 * Gate for deploy-production.yml. Each selected unit (backend, web) must have a stable release tag
 * (`@tinychat/backend@X.Y.Z` / `@tinychat/frontend@X.Y.Z`, matching its package.json version) on the commit being
 * deployed, and that commit must be on --main (fetch it fresh first). Anything else is an unreleased hotfix, allowed
 * only with --allow-unreleased true plus --confirm-sha equal to the full commit SHA. Writes label, released,
 * backend-version and frontend-version to $GITHUB_OUTPUT.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BACKEND, FRONTEND, STABLE_VERSION, git, repoRoot, setOutput } from './lib.mjs';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    backend: { type: 'string' },
    web: { type: 'string' },
    'allow-unreleased': { type: 'string', default: 'false' },
    'confirm-sha': { type: 'string', default: '' },
    main: { type: 'string', default: 'refs/remotes/origin/main' },
  },
});
const root = resolve(values.root ?? repoRoot);
const flag = name => {
  if (!['true', 'false'].includes(values[name])) throw new Error(`--${name} must be true or false, got ${JSON.stringify(values[name])}`);
  return values[name] === 'true';
};
const units = [
  { name: BACKEND, dir: 'backend', selected: flag('backend') },
  { name: FRONTEND, dir: 'frontend', selected: flag('web') },
].filter(unit => unit.selected);
if (units.length === 0) throw new Error('Nothing to deploy: set backend and/or web');

const sha = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
const version = dir => JSON.parse(git(root, ['show', `${sha}:${dir}/package.json`])).version;
const tagsHere = new Set(git(root, ['tag', '--points-at', sha]).split('\n').filter(Boolean));
const onMain = git(root, ['merge-base', '--is-ancestor', sha, values.main], { allowFailure: true }) !== undefined;

const unreleased = units.flatMap(unit => {
  const tag = `${unit.name}@${version(unit.dir)}`;
  if (!STABLE_VERSION.test(version(unit.dir))) return [`${unit.name} is at ${version(unit.dir)}, not a stable version`];
  if (!tagsHere.has(tag)) return [`${tag} does not tag ${sha}`];
  return [];
});
if (!onMain) unreleased.push(`${sha} is not on ${values.main}`);

let label;
if (unreleased.length === 0) {
  label = units.map(unit => `${unit.name}@${version(unit.dir)}`).join(' ');
} else if (flag('allow-unreleased') && values['confirm-sha'] === sha) {
  label = `unreleased hotfix ${sha.slice(0, 12)}`;
  console.log(`::warning::Deploying unreleased ${sha}: ${unreleased.join('; ')}`);
} else {
  throw new Error([
    `Refusing to deploy ${sha} to production: ${unreleased.join('; ')}.`,
    'Deploy a stable release: gh workflow run deploy-production.yml --ref refs/tags/<@tinychat/backend|@tinychat/frontend>@<X.Y.Z>.',
    `For an unreleased hotfix, re-run with -f allow_unreleased=true -f confirm_sha=${sha}.`,
  ].join(' '));
}

console.log(`deploy target ${sha}: ${label}`);
setOutput('label', label);
setOutput('released', String(unreleased.length === 0));
setOutput('backend-version', version('backend'));
setOutput('frontend-version', version('frontend'));
