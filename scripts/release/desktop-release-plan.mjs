#!/usr/bin/env node
/**
 * Plan the GitHub Release for one exo-desktop@<version> tag. desktop-release.yml runs this (from main, its trusted
 * copy) after fetching main and the tag fresh: the tag must name a release version, point at a commit of --main
 * (release tags are created only by the Release workflow; see the rulesets in docs/deployment.md), and match
 * desktop/package.json at that commit. Version, changelogs and the bundled web version are read from that commit, not
 * from the checkout. A beta becomes a pre-release, a stable version a published Release marked latest. Writes the
 * release notes to --notes and tag, sha, version, channel, prerelease, title, asset-prefix, signing to $GITHUB_OUTPUT.
 *
 * --signing is the EXO_DESKTOP_SIGNING repository variable and must be set explicitly: `required` (Developer ID
 * signed and notarized; publishing refuses anything else) or `unsigned` (no signing at all; the release title and
 * notes say UNSIGNED). Anything else, including unset, fails.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DESKTOP, FRONTEND, VERSION, changelogSection, desktopBundleVersions, git, repoRoot, setOutput } from './lib.mjs';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    tag: { type: 'string' },
    notes: { type: 'string' },
    signing: { type: 'string' },
    main: { type: 'string', default: 'refs/remotes/origin/main' },
  },
});
const root = resolve(values.root ?? repoRoot);
if (!values.tag || !values.notes) throw new Error('--tag and --notes are required');
const SIGNING_MODES = ['required', 'unsigned'];
if (!SIGNING_MODES.includes(values.signing)) {
  throw new Error(`EXO_DESKTOP_SIGNING must be "required" (Developer ID sign + notarize) or "unsigned" (publish marked UNSIGNED), got ${JSON.stringify(values.signing ?? '')}. Set the repository variable: gh variable set EXO_DESKTOP_SIGNING --body <required|unsigned>`);
}
const unsigned = values.signing === 'unsigned';

const prefix = `${DESKTOP.crate}@`;
const version = values.tag.startsWith(prefix) ? values.tag.slice(prefix.length) : '';
if (!VERSION.test(version)) throw new Error(`Desktop releases need an ${prefix}<X.Y.Z or X.Y.Z-beta.N> tag, got ${JSON.stringify(values.tag)}`);
const sha = git(root, ['rev-parse', '--verify', '-q', `refs/tags/${values.tag}^{commit}`], { allowFailure: true });
if (!sha) throw new Error(`Tag ${values.tag} does not exist`);
if (git(root, ['merge-base', '--is-ancestor', sha, values.main], { allowFailure: true }) === undefined) {
  throw new Error(`${values.tag} points at ${sha}, which is not on ${values.main}: only release tags on main are built`);
}

const show = rel => git(root, ['show', `${sha}:${rel}`], { allowFailure: true });
const packageVersion = JSON.parse(show(DESKTOP.packageJson)).version;
if (packageVersion !== version) throw new Error(`${values.tag} does not match ${DESKTOP.packageJson} version ${packageVersion} at ${sha}`);
const { shortVersion, bundleVersion, prerelease } = desktopBundleVersions(version);
const frontendVersion = JSON.parse(show('frontend/package.json')).version;
const desktopChanges = changelogSection(show('desktop/CHANGELOG.md') ?? '', version);
const webChanges = changelogSection(show('frontend/CHANGELOG.md') ?? '', version);

const notes = [
  ...(unsigned ? ['> **UNSIGNED — macOS will warn; right-click → Open, or `xattr -dr com.apple.quarantine Exo.app`.** This build is not Developer ID signed or notarized.', ''] : []),
  ...(prerelease ? [`> **Beta.** A pre-release of Exo ${shortVersion}, built from \`main\`. It uses the production API (api.tinycloud.chat).`, ''] : []),
  ...(desktopChanges ? ['## Desktop', '', desktopChanges, ''] : []),
  ...(webChanges ? [`## Web app (bundled, ${FRONTEND}@${frontendVersion})`, '', webChanges, ''] : []),
  ...(!desktopChanges && !webChanges ? ['No changes in this release.', ''] : []),
  '## Build',
  '',
  `- Exo ${version} for Apple Silicon Macs, macOS 14.2 or later, built from \`${sha}\`.`,
  `- Bundles the web app ${FRONTEND}@${frontendVersion}.`,
  `- Info.plist: CFBundleShortVersionString ${shortVersion}, CFBundleVersion ${bundleVersion}.`,
  unsigned
    ? '- UNSIGNED: not Developer ID signed or notarized. Check downloads against SHA256SUMS.txt.'
    : '- Developer ID signed, notarized and stapled. Check downloads against SHA256SUMS.txt.',
  '',
].join('\n');
writeFileSync(values.notes, notes);
console.log(notes);

setOutput('tag', values.tag);
setOutput('sha', sha);
setOutput('version', version);
setOutput('channel', prerelease ? 'beta' : 'stable');
setOutput('prerelease', String(prerelease));
const labels = [...(prerelease ? ['beta'] : []), ...(unsigned ? ['UNSIGNED'] : [])];
setOutput('title', labels.length ? `Exo ${version} (${labels.join(', ')})` : `Exo ${version}`);
setOutput('asset-prefix', `Exo_${version}_aarch64`);
setOutput('signing', values.signing);
