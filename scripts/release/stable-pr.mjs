#!/usr/bin/env node
/**
 * Prepare the long-running "Release stable" PR (js-sdk's "exit pre mode" PR, kept current automatically):
 * local branch release/stable = HEAD + `changeset pre exit` + the recorded plan (.changeset/release-stable.json, which
 * check.mjs compares with what stable would ship when the PR is checked and merged), and a PR body from
 * `changeset status` in exit mode. Run on main after version.mjs. Writes open=true|false to $GITHUB_OUTPUT
 * (false when no beta is waiting to go stable) and returns to the original branch.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BACKEND, BRANCH_STABLE, FIXED, PRE_TAG, STABLE_PLAN, STABLE_SCOPE_FRONTEND_DESKTOP, changeset, git, readPreState,
  repoRoot, setOutput, stablePlan, withIgnoredPackages,
} from './lib.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, body: { type: 'string' } } });
const root = resolve(values.root ?? repoRoot);
if (!values.body) throw new Error('--body <file> is required');

if (git(root, ['status', '--porcelain'])) throw new Error('Refusing to prepare the Release stable PR from a dirty working tree');
const pre = readPreState(root);
if (pre?.mode !== 'pre' || pre.tag !== PRE_TAG) throw new Error(`Expected beta pre mode on main, found ${JSON.stringify(pre)}`);

const recorded = stablePlan(root, pre.stableScope);
const origin = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
git(root, ['switch', '-q', '-C', BRANCH_STABLE]);
const prePath = join(root, '.changeset/pre.json');
if (pre.stableScope !== undefined) writeFileSync(prePath, `${JSON.stringify({ mode: 'pre', tag: pre.tag }, null, 2)}\n`);
changeset(root, ['pre', 'exit']);
if (pre.stableScope !== undefined) {
  writeFileSync(prePath, `${JSON.stringify({ mode: 'exit', tag: pre.tag, stableScope: pre.stableScope }, null, 2)}\n`);
}
writeFileSync(join(root, STABLE_PLAN), `${JSON.stringify(recorded, null, 2)}\n`);
git(root, ['add', '.changeset/pre.json', STABLE_PLAN]);
git(root, ['commit', '-q', '-m', 'chore(release): release stable']);
const planFile = join(mkdtempSync(join(tmpdir(), 'release-stable-')), 'plan.json');
const createPlan = () => changeset(root, ['status', '--output', planFile]);
if (recorded.scope === STABLE_SCOPE_FRONTEND_DESKTOP) withIgnoredPackages(root, [BACKEND], createPlan);
else createPlan();
git(root, ['switch', '-q', origin]);

const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const releases = plan.releases.filter(release => release.type !== 'none').sort((a, b) => a.name.localeCompare(b.name));
const planned = Object.fromEntries(releases.map(release => [release.name, release.newVersion]));
if (JSON.stringify(Object.entries(planned).sort()) !== JSON.stringify(Object.entries(recorded.versions).sort())) {
  throw new Error(`Changesets would release ${JSON.stringify(planned)}, but the recorded stable plan is ${JSON.stringify(recorded.versions)}`);
}
if (releases.length === 0) {
  console.log('No beta is waiting to go stable.');
  setOutput('open', 'false');
} else {
  const summaries = new Map(plan.changesets.map(({ id, summary }) => [id, summary.trim()]));
  const scopeNotes = recorded.scope === STABLE_SCOPE_FRONTEND_DESKTOP ? [
    'Promotes only `@tinychat/frontend` and `exo-desktop`.',
    'The backend prerelease and its admitted changesets remain pending.',
    '',
    '### Pending backend prerelease',
    ...Object.entries(recorded.pending.versions).map(([name, version]) => `- \`${name}\` remains \`${version}\`.`),
    ...recorded.pending.changesets.map(file => `- \`${file}\` remains pending.`),
    '',
  ] : [];
  const body = [
    'Maintained by the Release workflow; it rebuilds this branch after every push to main. It changes only',
    '`.changeset/pre.json` (`"mode": "exit"`) and records this plan in `.changeset/release-stable.json`. Merging it',
    'makes the Release workflow version these stable releases, tag them, and re-enter beta pre mode. If main moved',
    'on since this plan was recorded, the Release check refuses the stale plan instead of releasing it.',
    '',
    ...scopeNotes,
    '| Unit | Current | Stable | Bump |',
    '|---|---|---|---|',
    ...releases.map(release => `| \`${release.name}\` | ${release.oldVersion} | **${release.newVersion}** | ${release.type} |`),
    '',
    ...releases.flatMap(release => [
      `### ${release.name}@${release.newVersion}`,
      '',
      ...(release.changesets.length
        ? [...new Set(release.changesets.map(id => summaries.get(id)))].map(summary => `- ${summary.replace(/\n/g, '\n  ')}`)
        : [FIXED.includes(release.name)
          ? `- Same release as ${FIXED.filter(name => name !== release.name).join(', ')} (one version for web and desktop).`
          : '- Version bump only.']),
      '',
    ]),
  ].join('\n');
  writeFileSync(values.body, body);
  console.log(body);
  setOutput('open', 'true');
}
