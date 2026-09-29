#!/usr/bin/env node
/** Copy desktop/package.json's version (the single source of truth) into Cargo.toml and Cargo.lock without running cargo. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DESKTOP, STABLE_VERSION, readJson, repoRoot, setCargoLockVersion, setCargoTomlVersion } from './units.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' } } });
const root = resolve(values.root ?? repoRoot);

const { version } = readJson(root, DESKTOP.packageJson);
if (!STABLE_VERSION.test(version ?? '')) throw new Error(`${DESKTOP.packageJson} version must be X.Y.Z, got ${JSON.stringify(version)}`);

for (const [rel, set] of [[DESKTOP.cargoToml, setCargoTomlVersion], [DESKTOP.cargoLock, setCargoLockVersion]]) {
  const path = join(root, rel);
  const before = readFileSync(path, 'utf8');
  const after = set(before, version);
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`${rel}: ${DESKTOP.crate} -> ${version}`);
  }
}
