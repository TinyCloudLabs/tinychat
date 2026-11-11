#!/usr/bin/env node
/**
 * Write the Tauri config overlay every desktop build uses (`tauri build --config <out>/tauri.bundle.conf.json`): an
 * Info.plist overlay with Apple's numeric CFBundleShortVersionString / CFBundleVersion for desktop/package.json's
 * version (see desktopBundleVersions). Tauri merges bundle.macOS.infoPlist over src-tauri/Info.plist and over the
 * keys it generates, so only these two keys change; the app's own version stays the semver. --ad-hoc-sign (unsigned
 * builds) also sets bundle.macOS.signingIdentity "-", so tauri bundle ad-hoc signs the app (sealing its resources)
 * before it builds the DMG. --smoke assigns an isolated bundle identifier and product name for recorder-failpoints
 * artifacts ("<identifier>.smoke", "<productName> Smoke"). The product name and identifier are read from the built
 * tree's src-tauri/tauri.conf.json.
 * Writes version, short-version, bundle-version, prerelease, product-name, bundle-identifier and config to $GITHUB_OUTPUT.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DESKTOP, desktopBundleVersions, desktopProduct, readJson, repoRoot, setOutput } from './lib.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' }, 'ad-hoc-sign': { type: 'boolean', default: false }, smoke: { type: 'boolean', default: false } } });
const root = resolve(values.root ?? repoRoot);
if (!values.out) throw new Error('--out <dir> is required');
const out = resolve(values.out);

const { version } = readJson(root, DESKTOP.packageJson);
const { shortVersion, bundleVersion, prerelease } = desktopBundleVersions(version);
const app = desktopProduct(readFileSync(join(root, DESKTOP.tauriConf), 'utf8'));
const productName = values.smoke ? `${app.productName} Smoke` : app.productName;
const identifier = values.smoke ? `${app.identifier}.smoke` : app.identifier;

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
const configPath = join(out, 'tauri.bundle.conf.json');
const macOS = {
  infoPlist: plist,
  ...(values['ad-hoc-sign'] ? { signingIdentity: '-' } : {}),
};
const config = {
  ...(values.smoke ? { identifier, productName } : {}),
  bundle: { macOS },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`${productName} ${version}: CFBundleShortVersionString ${shortVersion}, CFBundleVersion ${bundleVersion}`);
setOutput('version', version);
setOutput('short-version', shortVersion);
setOutput('bundle-version', bundleVersion);
setOutput('prerelease', String(prerelease));
setOutput('product-name', productName);
setOutput('bundle-identifier', identifier);
setOutput('config', configPath);
