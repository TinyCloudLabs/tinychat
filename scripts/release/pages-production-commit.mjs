#!/usr/bin/env node
/**
 * Create (locally) the commit that deploys --target (default HEAD) to Cloudflare Pages production. Its tree is
 * exactly the target's; its parents are the current production branch tip (so pushing it is a fast-forward, never a
 * force push) and the target (so history shows what shipped). A fresh commit, rather than moving the branch onto
 * the target, also keeps the release commit's `[skip ci]` out of the pushed tip, which Pages would otherwise skip.
 * Fails when the production branch does not exist: Pages would build a new branch as a preview, not production.
 * Writes commit=<sha> to $GITHUB_OUTPUT.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BRANCH_PRODUCTION, git, repoRoot, setOutput } from './lib.mjs';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    target: { type: 'string', default: 'HEAD' },
    production: { type: 'string', default: `refs/remotes/origin/${BRANCH_PRODUCTION}` },
    label: { type: 'string' },
    body: { type: 'string', default: '' },
  },
});
const root = resolve(values.root ?? repoRoot);
if (!values.label) throw new Error('--label is required');

const target = git(root, ['rev-parse', '--verify', `${values.target}^{commit}`]);
const production = git(root, ['rev-parse', '--verify', '-q', `${values.production}^{commit}`], { allowFailure: true });
if (production === undefined) {
  throw new Error(`${values.production} does not exist. Create the "${BRANCH_PRODUCTION}" branch and make it the Cloudflare Pages production branch first (docs/deployment.md).`);
}

const message = [`deploy(web): ${values.label}`, '', `Source: ${target}`, ...(values.body ? [values.body] : [])].join('\n');
const commit = git(root, ['commit-tree', `${target}^{tree}`, '-p', production, '-p', target, '-m', message]);
console.log(`${BRANCH_PRODUCTION}: ${production} -> ${commit} (tree of ${target})`);
setOutput('commit', commit);
