#!/usr/bin/env node
/**
 * Start the downstream workflows for the tags this Release run pushed (see planDispatches in lib.mjs): tags pushed
 * with GITHUB_TOKEN trigger no workflow, so each one is dispatched on its tag ref. Fails loudly, before dispatching
 * anything, if the tags of one dispatch are not on the same commit. --dry-run prints the gh commands instead.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { git, planDispatches, repoRoot, run } from './lib.mjs';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    channel: { type: 'string' },
    tags: { type: 'string', default: '' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const root = resolve(values.root ?? repoRoot);
const dispatches = planDispatches({ channel: values.channel, tags: values.tags.split(/\s+/).filter(Boolean) });

for (const { workflow, tags } of dispatches) {
  const commits = new Set(tags.map(tag => git(root, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`])));
  if (commits.size !== 1) throw new Error(`${workflow}: ${tags.join(', ')} must all tag one commit, found ${[...commits].join(', ')}`);
}

if (dispatches.length === 0) console.log(`Nothing to dispatch for channel ${values.channel} (${values.tags || 'no new tags'}).`);
for (const { workflow, ref, inputs } of dispatches) {
  const args = ['workflow', 'run', workflow, '--repo', process.env.GITHUB_REPOSITORY || 'TinyCloudLabs/tinychat', '--ref', ref,
    ...Object.entries(inputs).flatMap(([key, value]) => ['-f', `${key}=${value}`])];
  if (values['dry-run']) {
    console.log(`gh ${args.join(' ')}`);
  } else {
    run(root, 'gh', args);
    console.log(`dispatched ${workflow} on ${ref} (${Object.entries(inputs).map(([key, value]) => `${key}=${value}`).join(', ')})`);
  }
}
