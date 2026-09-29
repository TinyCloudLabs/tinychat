#!/usr/bin/env node
/**
 * Wait for Cloudflare Pages to deploy a production-branch commit and prove it is live (see classifyPagesCheckRuns):
 *  1. the "Cloudflare Pages" check run on --commit succeeds as a production (not preview) deployment;
 *  2. --url (the production domain) serves the same index.html as that deployment's unique URL;
 *  3. the production branch still points at --commit before and after (nothing else moved it meanwhile).
 * Fails loudly on a failed build, a preview build, a moved branch, or a timeout. Needs GH_TOKEN and GITHUB_REPOSITORY.
 */
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { BRANCH_PRODUCTION, classifyPagesCheckRuns, repoRoot, run } from './lib.mjs';

const { values } = parseArgs({
  options: {
    commit: { type: 'string' },
    url: { type: 'string' },
    'build-minutes': { type: 'string', default: '20' },
    'live-minutes': { type: 'string', default: '5' },
  },
});
if (!values.commit || !values.url) throw new Error('--commit and --url are required');
const repo = process.env.GITHUB_REPOSITORY;
if (!repo) throw new Error('GITHUB_REPOSITORY is required');

function requireTip(when) {
  const tip = run(repoRoot, 'gh', ['api', `repos/${repo}/git/ref/heads/${BRANCH_PRODUCTION}`, '--jq', '.object.sha']);
  if (tip !== values.commit) throw new Error(`${when}, ${BRANCH_PRODUCTION} points at ${tip}, not the deploy commit ${values.commit}: something else pushed it.`);
  console.log(`${when}: ${BRANCH_PRODUCTION} is at ${values.commit}`);
}
requireTip('Before waiting for Pages');

async function poll(minutes, attempt) {
  const deadline = Date.now() + Number(minutes) * 60_000;
  for (;;) {
    const result = await attempt();
    if (result !== undefined) return result;
    if (Date.now() > deadline) return undefined;
    await sleep(15_000);
  }
}

const pages = await poll(values['build-minutes'], () => {
  const json = run(repoRoot, 'gh', ['api', `repos/${repo}/commits/${values.commit}/check-runs?per_page=100`]);
  const status = classifyPagesCheckRuns(JSON.parse(json).check_runs);
  console.log(`Cloudflare Pages on ${values.commit}: ${status.state}`);
  return status.state === 'waiting' ? undefined : status;
});
if (!pages) throw new Error(`No finished Cloudflare Pages check run on ${values.commit} after ${values['build-minutes']} minutes: is the Pages Git integration still connected?`);
if (pages.state === 'failed') throw new Error(`Cloudflare Pages build failed (${pages.reason}): ${pages.detailsUrl}`);
if (pages.state === 'preview') {
  throw new Error(`Cloudflare Pages built ${values.commit} as a preview, not production: set the Pages project's production branch to "${BRANCH_PRODUCTION}" (docs/deployment.md), then re-run. ${pages.detailsUrl}`);
}

async function indexHtml(url) {
  const bust = new URL(url);
  bust.searchParams.set('deploy', values.commit);
  const response = await fetch(bust, { headers: { 'cache-control': 'no-cache' } });
  if (!response.ok) throw new Error(`GET ${bust} -> ${response.status}`);
  return response.text();
}

const expected = await indexHtml(pages.deploymentUrl);
const live = await poll(values['live-minutes'], async () => {
  const served = await indexHtml(values.url);
  console.log(`${values.url} ${served === expected ? 'serves' : 'does not serve yet'} ${pages.deploymentUrl}`);
  return served === expected ? true : undefined;
});
if (!live) throw new Error(`${values.url} does not serve deployment ${pages.deploymentUrl} after ${values['live-minutes']} minutes`);
requireTip('After verifying tinycloud.chat');

const summary = `- Web: ${values.url} serves Cloudflare Pages deployment ${pages.deploymentUrl} ([logs](${pages.detailsUrl})) from \`${values.commit}\`\n`;
console.log(summary.trim());
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
