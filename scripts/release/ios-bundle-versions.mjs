#!/usr/bin/env node
/**
 * Apple's numeric versions for an Exo iOS build (.github/workflows/ios-build.yml). CFBundleShortVersionString is the
 * product version from frontend/package.json (web, desktop and mobile are one product version) without its beta
 * suffix, so 0.2.0-beta.2 builds as 0.2.0; CFBundleVersion is --build-number (TestFlight: the workflow's run number,
 * which only grows, so every upload gets a new build). The build passes them to xcodebuild as MARKETING_VERSION and
 * CURRENT_PROJECT_VERSION, which mobile/ios/App/App/Info.plist reads. Writes version, short-version and build-number
 * to $GITHUB_OUTPUT.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FRONTEND, desktopBundleVersions, readJson, repoRoot, setOutput } from './lib.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, 'build-number': { type: 'string' } } });
const root = resolve(values.root ?? repoRoot);
const buildNumber = values['build-number'] ?? '';
if (!/^[1-9]\d{0,8}$/.test(buildNumber)) {
  throw new Error(`--build-number must be a positive integer, got ${JSON.stringify(buildNumber)}`);
}

const { name, version } = readJson(root, 'frontend/package.json');
if (name !== FRONTEND) throw new Error(`frontend/package.json is ${name}, expected ${FRONTEND}`);
// Same X.Y.Z mapping as the desktop app's CFBundleShortVersionString.
const { shortVersion } = desktopBundleVersions(version);

console.log(`Exo ${version}: CFBundleShortVersionString ${shortVersion}, CFBundleVersion ${buildNumber}`);
setOutput('version', version);
setOutput('short-version', shortVersion);
setOutput('build-number', buildNumber);
