/** Release units and the desktop version files. Every other workspace package is private and ignored by Changesets. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const UNITS = [
  { name: 'exo-desktop', dir: 'desktop' },
  { name: '@tinychat/frontend', dir: 'frontend' },
  { name: '@tinychat/backend', dir: 'backend' },
];

export const DESKTOP = {
  packageJson: 'desktop/package.json',
  tauriConf: 'desktop/src-tauri/tauri.conf.json',
  cargoToml: 'desktop/src-tauri/Cargo.toml',
  cargoLock: 'desktop/src-tauri/Cargo.lock',
  crate: 'exo-desktop',
};

// Apple requires a numeric CFBundleShortVersionString, and releases are stable-only.
export const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

export const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

// `version = "..."` inside the [package] table of Cargo.toml.
const cargoTomlVersion = /^(\[package\]\n(?:(?!\[)[^\n]*\n)*?version = ")([^"\n]*)(")/m;

// The `[[package]] name = "<crate>" version = "..."` entry in Cargo.lock.
const cargoLockVersion = crate => new RegExp(`^(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")([^"\\n]*)(")`, 'gm');

function single(text, regex, what) {
  const matches = [...text.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`))];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${what}, found ${matches.length}`);
  return matches[0][2];
}

export const readCargoTomlVersion = text => single(text, cargoTomlVersion, '[package] version in Cargo.toml');
export const readCargoLockVersion = text => single(text, cargoLockVersion(DESKTOP.crate), `${DESKTOP.crate} entry in Cargo.lock`);

export function setCargoTomlVersion(text, version) {
  readCargoTomlVersion(text);
  return text.replace(cargoTomlVersion, `$1${version}$3`);
}

export function setCargoLockVersion(text, version) {
  readCargoLockVersion(text);
  return text.replace(cargoLockVersion(DESKTOP.crate), `$1${version}$3`);
}
