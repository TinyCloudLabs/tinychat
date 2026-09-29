#!/usr/bin/env node
/**
 * Port of TinyCloudLabs/js-sdk scripts/check-beta-release-plan.mjs for Changesets v3: refuse to version a major bump
 * from a changeset no beta has released yet (v3 moves released ones to .changeset/pre/), unless ALLOW_MAJOR_BETA=true
 * (the Release workflow dispatched with confirm=major-beta). Backend majors are rejected outright by check.mjs.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readChangesets, repoRoot } from './lib.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' } } });
const allowMajor = process.env.ALLOW_MAJOR_BETA === 'true';
const majorPackages = new Set();

for (const { file, admitted, error, releases } of readChangesets(resolve(values.root ?? repoRoot))) {
  if (error) throw new Error(`${file}: ${error}`);
  if (admitted) continue;
  for (const release of releases) if (release.type === 'major') majorPackages.add(release.name);
}

if (majorPackages.size > 0 && !allowMajor) {
  throw new Error(`Automatic release refuses unconfirmed major bumps: ${[...majorPackages].sort().join(', ')}. Review the change, then run the Release workflow with confirm=major-beta.`);
}

console.log(majorPackages.size === 0
  ? 'Release plan contains no unreleased major bumps.'
  : `Explicit major release confirmed for: ${[...majorPackages].sort().join(', ')}`);
