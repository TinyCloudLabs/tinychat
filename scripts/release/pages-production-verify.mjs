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
import { BRANCH_PRODUCTION, classifyPagesCheckRuns, explainUnservedHost, hostServesCommit, repoRoot, run } from './lib.mjs';

const { values } = parseArgs({
  options: {
    commit: { type: 'string' },
    url: { type: 'string' },
    'build-minutes': { type: 'string', default: '20' },
    'live-minutes': { type: 'string', default: '5' },
    'also-host': { type: 'string', multiple: true, default: [] },
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
let liveError;
const live = await poll(values['live-minutes'], async () => {
  let served;
  try {
    served = await indexHtml(values.url);
  } catch (error) {
    // A domain that is not attached to Pages yet fails here (no DNS, 404, 5xx): keep polling, name it at the end.
    liveError = error instanceof Error ? error.message : String(error);
    console.log(`${values.url} did not answer yet (${liveError})`);
    return undefined;
  }
  liveError = undefined;
  console.log(`${values.url} ${served === expected ? 'serves' : 'does not serve yet'} ${pages.deploymentUrl}`);
  return served === expected ? true : undefined;
});
if (!live) {
  const host = new URL(values.url).host;
  const why = await hostServesCommit(host, values.commit);
  const detail = why.ok
    ? `${host} names ${values.commit} in version.json, but its index.html differs from the deployment's`
    : explainUnservedHost(host, why.served, values.commit);
  throw new Error(`${values.url} does not serve deployment ${pages.deploymentUrl} after ${values['live-minutes']} minutes: ${detail}.${liveError ? ` Last fetch: ${liveError}.` : ''}`);
}
// Every other host that must serve this build (the other web domains of the same product). One Pages project serves
// several domains, and a domain that sits on another project keeps an old build: each must name the deployed commit,
// or send visitors to the production host with a redirect (tinycloud.chat does that for everyone but held visitors).
// The redirect is not followed, so a redirecting host is reported as redirecting, never as serving the commit.
const productionHost = new URL(values.url).host;
const stale = [];
const seen = [];
for (const host of values['also-host']) {
  let last;
  const result = await poll(values['live-minutes'], async () => {
    last = await hostServesCommit(host, values.commit, undefined, { productionHost });
    console.log(`${host} ${last.redirectedTo ? `redirects to ${last.redirectedTo} (${last.served}); not checked for the commit itself` : last.ok ? `serves ${values.commit}` : `does not serve yet (${last.served})`}`);
    return last.ok ? last : undefined;
  });
  if (!result) stale.push(explainUnservedHost(host, last?.served ?? 'no answer ()', values.commit));
  else seen.push(result.redirectedTo ? `${host} redirects to ${result.redirectedTo}` : `${host} serves the same commit`);
}
if (stale.length > 0) throw new Error(`These hosts do not serve ${values.commit} after ${values['live-minutes']} minutes:\n- ${stale.join('\n- ')}\nSee docs/deployment.md.`);
requireTip('After verifying the web hosts');

const alsoServed = seen.length ? `; ${seen.join('; ')}` : '';
const summary = `- Web: ${values.url} serves Cloudflare Pages deployment ${pages.deploymentUrl} ([logs](${pages.detailsUrl})) from \`${values.commit}\`${alsoServed}\n`;
console.log(summary.trim());
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
