#!/usr/bin/env node
/**
 * Write the Tauri config overlay every Exo build uses (`tauri build --config <out>/tauri.bundle.conf.json`): an
 * Info.plist overlay with Apple's numeric CFBundleShortVersionString / CFBundleVersion for desktop/package.json's
 * version (see desktopBundleVersions). Tauri merges bundle.macOS.infoPlist over src-tauri/Info.plist and over the
 * keys it generates, so only these two keys change; the app's own version stays the semver. --ad-hoc-sign (unsigned
 * builds) also sets bundle.macOS.signingIdentity "-", so tauri bundle ad-hoc signs the app (sealing its resources)
 * before it builds the DMG. Writes version, short-version, bundle-version, prerelease and config to $GITHUB_OUTPUT.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DESKTOP, desktopBundleVersions, readJson, repoRoot, setOutput } from './lib.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' }, 'ad-hoc-sign': { type: 'boolean', default: false } } });
const root = resolve(values.root ?? repoRoot);
if (!values.out) throw new Error('--out <dir> is required');
const out = resolve(values.out);

const { version } = readJson(root, DESKTOP.packageJson);
const { shortVersion, bundleVersion, prerelease } = desktopBundleVersions(version);

mkdirSync(out, { recursive: true });
const plist = join(out, 'Info.bundle-version.plist');
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleShortVersionString</key>
	<string>${shortVersion}</string>
	<key>CFBundleVersion</key>
	<string>${bundleVersion}</string>
</dict>
</plist>
`);
const config = join(out, 'tauri.bundle.conf.json');
const macOS = { infoPlist: plist, ...(values['ad-hoc-sign'] ? { signingIdentity: '-' } : {}) };
writeFileSync(config, `${JSON.stringify({ bundle: { macOS } }, null, 2)}\n`);

console.log(`Exo ${version}: CFBundleShortVersionString ${shortVersion}, CFBundleVersion ${bundleVersion}`);
setOutput('version', version);
setOutput('short-version', shortVersion);
setOutput('bundle-version', bundleVersion);
setOutput('prerelease', String(prerelease));
setOutput('config', config);
