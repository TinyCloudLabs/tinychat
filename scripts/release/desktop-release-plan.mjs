#!/usr/bin/env node
/**
 * Plan the GitHub Release for one exo-desktop@<version> tag (desktop-release.yml runs on that tag ref):
 * the ref must be refs/tags/exo-desktop@<desktop/package.json version>; a beta becomes a pre-release, a stable version
 * a published Release marked latest. Writes the release notes (desktop and bundled web changelog sections for this
 * version, plus build facts) to --notes and tag, version, channel, prerelease, title, asset-prefix, signed to
 * $GITHUB_OUTPUT.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DESKTOP, FRONTEND, changelogSection, desktopBundleVersions, readJson, repoRoot, setOutput } from './lib.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, ref: { type: 'string' }, notes: { type: 'string' } } });
const root = resolve(values.root ?? repoRoot);
if (!values.ref || !values.notes) throw new Error('--ref and --notes are required');

const prefix = `refs/tags/${DESKTOP.crate}@`;
if (!values.ref.startsWith(prefix)) {
  throw new Error(`Desktop releases run on an ${DESKTOP.crate}@<version> tag, got ${values.ref}. Re-run with: gh workflow run desktop-release.yml --ref ${prefix}<version>`);
}
const version = values.ref.slice(prefix.length);
const { shortVersion, bundleVersion, prerelease } = desktopBundleVersions(version);
const packageVersion = readJson(root, DESKTOP.packageJson).version;
if (packageVersion !== version) throw new Error(`${values.ref} does not match ${DESKTOP.packageJson} version ${packageVersion} at this commit`);

// Signing and notarization (PR D) are not wired yet, so only betas can ship, as clearly labelled unsigned
// pre-releases. A stable release is never published unsigned.
const signed = false;
if (!prerelease && !signed) {
  throw new Error(`Refusing to publish ${DESKTOP.crate}@${version} unsigned: stable Exo releases must be Developer ID signed and notarized.`);
}

const channel = prerelease ? 'beta' : 'stable';
const frontendVersion = readJson(root, 'frontend/package.json').version;
const section = rel => existsSync(join(root, rel)) ? changelogSection(readFileSync(join(root, rel), 'utf8'), version) : '';
const desktopChanges = section('desktop/CHANGELOG.md');
const webChanges = section('frontend/CHANGELOG.md');

const notes = [
  ...(prerelease ? [`> **Beta.** A pre-release of Exo ${shortVersion}, built from \`main\`. It uses the production API (api.tinycloud.chat).`, ''] : []),
  ...(signed ? [] : [
    '> **Unsigned.** This build is not signed or notarized, so macOS refuses to open it (it may call the app damaged). After dragging Exo to Applications, run `xattr -dr com.apple.quarantine /Applications/Exo.app` in Terminal, then open it. Microphone and system-audio permissions are asked again after every update.',
    '',
  ]),
  ...(desktopChanges ? ['## Desktop', '', desktopChanges, ''] : []),
  ...(webChanges ? [`## Web app (bundled, ${FRONTEND}@${frontendVersion})`, '', webChanges, ''] : []),
  ...(!desktopChanges && !webChanges ? ['No changes in this release.', ''] : []),
  '## Build',
  '',
  `- Exo ${version} for Apple Silicon Macs, macOS 14.2 or later.`,
  `- Bundles the web app ${FRONTEND}@${frontendVersion}.`,
  `- Info.plist: CFBundleShortVersionString ${shortVersion}, CFBundleVersion ${bundleVersion}.`,
  `- ${signed ? 'Developer ID signed and notarized.' : 'Not signed or notarized.'} Check downloads against SHA256SUMS.txt.`,
  '',
].join('\n');
writeFileSync(values.notes, notes);
console.log(notes);

setOutput('tag', `${DESKTOP.crate}@${version}`);
setOutput('version', version);
setOutput('channel', channel);
setOutput('prerelease', String(prerelease));
setOutput('title', prerelease ? `Exo ${version} (beta${signed ? '' : ', unsigned'})` : `Exo ${version}`);
setOutput('asset-prefix', `Exo_${version}_aarch64${signed ? '' : '_UNSIGNED'}`);
setOutput('signed', String(signed));
