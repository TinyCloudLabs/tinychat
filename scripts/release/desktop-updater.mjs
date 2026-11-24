#!/usr/bin/env node
/**
 * The desktop app's in-app updater artifacts (TC-4275): the minisign signature of the notarized app's .app.tar.gz and
 * the latest.json the app's updater reads (desktop/src-tauri/tauri.conf.json plugins.updater, endpoint
 * releases/latest/download/latest.json). desktop-build.yml's sign job and desktop-release.yml's publish job run it from
 * the workflow commit's scripts/release, with Node's built-ins only: no node_modules, no tauri CLI on the runners that
 * hold the key. The format is the Tauri CLI's (`tauri signer sign`): a minisign prehashed (BLAKE2b-512) Ed25519
 * signature whose trusted comment carries the version (the app sets requireSignedVersion), base64-encoded once more.
 *
 *   desktop-updater.mjs sign --archive <app.tar.gz> --version <X.Y.Z[-beta.N]> --pubkey <tauri updater pubkey>
 *       sign with TAURI_SIGNING_PRIVATE_KEY (the content of a `tauri signer generate` key file) and
 *       TAURI_SIGNING_PRIVATE_KEY_PASSWORD; refuses a placeholder or a key that is not --pubkey's; writes <archive>.sig
 *       and verifies it against --pubkey
 *   desktop-updater.mjs manifest --archive <app.tar.gz> --signature <app.tar.gz.sig> --version <v> --pubkey <key>
 *       --url <https asset url> --notes <file> --out <latest.json> [--pub-date <RFC 3339>]
 *       verify --signature against --archive, --pubkey and --version, then write latest.json for darwin-aarch64 (the
 *       only build)
 *   desktop-updater.mjs generate --dir <dir> --password-file <0600 file | ->
 *       the release key, minted once (desktop/README.md, "In-app updates"): `tauri signer generate`'s format and scrypt
 *       limits, encrypted with the password read from a file only its owner can read, or from stdin ("-"), so it never
 *       appears in any process's arguments. Writes <dir>/updater.key (0600) and <dir>/updater.key.pub; prints the
 *       public key
 *   desktop-updater.mjs keygen --dir <dir>
 *       CI dry runs only: a throwaway key in Tauri's format (<dir>/updater.key, mode 0600, random password in
 *       <dir>/password, light scrypt limits); prints its public key
 *
 * No key, password or signature value is ever printed.
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, scryptSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

// lib.mjs's VERSION, repeated so this script, which runs next to the signing key, imports Node's built-ins only.
const VERSION = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;

/** The committed stand-in until the release key is minted; a signed release refuses it. */
export const PLACEHOLDER_PREFIX = 'PLACEHOLDER';
/** The only architecture desktop-build.yml builds (Apple Silicon). */
export const PLATFORM = 'darwin-aarch64';

// ── BLAKE2b (RFC 7693), for the secret key's checksum: Node's crypto has only the unparameterized BLAKE2b-512 ─────
const M64 = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & M64;

export function blake2b(data, outlen) {
  const h = IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outlen);
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let i = 0; i < blocks; i++) {
    const last = i === blocks - 1;
    const block = Buffer.alloc(128);
    data.copy(block, 0, i * 128, Math.min(data.length, (i + 1) * 128));
    const v = [...h, ...IV];
    v[12] ^= BigInt(last ? data.length : (i + 1) * 128);
    if (last) v[14] ^= M64;
    const m = Array.from({ length: 16 }, (_, j) => block.readBigUInt64LE(j * 8));
    const g = (a, b, c, d, x, y) => {
      v[a] = (v[a] + v[b] + x) & M64; v[d] = rotr(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 24n);
      v[a] = (v[a] + v[b] + y) & M64; v[d] = rotr(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      g(0, 4, 8, 12, m[s[0]], m[s[1]]); g(1, 5, 9, 13, m[s[2]], m[s[3]]);
      g(2, 6, 10, 14, m[s[4]], m[s[5]]); g(3, 7, 11, 15, m[s[6]], m[s[7]]);
      g(0, 5, 10, 15, m[s[8]], m[s[9]]); g(1, 6, 11, 12, m[s[10]], m[s[11]]);
      g(2, 7, 8, 13, m[s[12]], m[s[13]]); g(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let j = 0; j < 8; j++) h[j] ^= v[j] ^ v[j + 8];
  }
  const out = Buffer.alloc(64);
  h.forEach((word, j) => out.writeBigUInt64LE(word, j * 8));
  return out.subarray(0, outlen);
}

// ── minisign boxes, as the Tauri CLI writes them: base64 of the text file ─────────────────────────────────────────
const b64 = buf => Buffer.from(buf).toString('base64');
const unb64 = text => Buffer.from(text, 'base64');

/** Lines of a box given either as Tauri's base64 of the file or as the file text itself. */
function boxLines(value, what) {
  const text = String(value ?? '').trim();
  const decoded = text.startsWith('untrusted comment:') ? text : unb64(text).toString('utf8');
  const lines = decoded.split('\n').map(line => line.replace(/\r$/, ''));
  if (!lines[0]?.startsWith('untrusted comment:') || !lines[1]) throw new Error(`${what} is not a minisign box`);
  return lines;
}

export function parsePublicKey(pubkey) {
  if (String(pubkey ?? '').startsWith(PLACEHOLDER_PREFIX)) {
    throw new Error('The updater public key in desktop/src-tauri/tauri.conf.json is still the placeholder: mint the release key first (desktop/README.md, "In-app updates")');
  }
  const raw = unb64(boxLines(pubkey, 'The updater public key')[1]);
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') throw new Error('The updater public key is not an Ed25519 minisign key');
  return { keyId: raw.subarray(2, 10), publicKey: raw.subarray(10, 42) };
}

/**
 * The app's two trusted keys (tauri.conf.json plugins.updater.pubkey and .backupPubkey, src-tauri/src/
 * desktop_update.rs): both still placeholders (not minted yet; `sign` refuses the placeholder primary, so no signed
 * release ships that way), or two Ed25519 minisign keys with distinct key ids. The app routes a signature to a key by
 * its id, so a placeholder backup, or the primary re-encoded with another comment, would ship installs that can never
 * rotate.
 */
export function checkTrustedKeys(primary, backup) {
  if (typeof backup !== 'string' || !backup) throw new Error('plugins.updater.backupPubkey is missing');
  const placeholder = key => String(key ?? '').startsWith(PLACEHOLDER_PREFIX);
  if (placeholder(primary) && placeholder(backup)) return;
  if (placeholder(backup)) throw new Error('plugins.updater.backupPubkey is still the placeholder while the primary key is minted: mint the backup key too (desktop/README.md, "In-app updates")');
  const keys = [primary, backup].map(parsePublicKey);
  if (keys[0].keyId.equals(keys[1].keyId) || keys[0].publicKey.equals(keys[1].publicKey)) {
    throw new Error('plugins.updater.backupPubkey must be a second key, not the primary key again');
  }
}

/** libsodium's crypto_pwhash_scryptsalsa208sha256 parameters for minisign's opslimit/memlimit. */
export function scryptParams(opslimit, memlimit) {
  const ops = opslimit < 32768n ? 32768n : opslimit;
  const r = 8n;
  let logN = 1n;
  let p;
  if (ops < memlimit / 32n) {
    p = 1n;
    const maxN = ops / (r * 4n);
    while (logN < 63n && (1n << logN) <= maxN / 2n) logN++;
  } else {
    const maxN = memlimit / (r * 128n);
    while (logN < 63n && (1n << logN) <= maxN / 2n) logN++;
    let maxrp = (ops / 4n) / (1n << logN);
    if (maxrp > 0x3fffffffn) maxrp = 0x3fffffffn;
    p = maxrp / r;
  }
  return { N: Number(1n << logN), r: Number(r), p: Number(p) };
}

const kdfStream = (password, salt, opslimit, memlimit) => {
  const { N, r, p } = scryptParams(opslimit, memlimit);
  return scryptSync(Buffer.from(password, 'utf8'), salt, 104, { N, r, p, maxmem: 256 * N * r * p + 64 * 1024 * 1024 });
};
const xor = (a, b) => Buffer.from(a.map((byte, i) => byte ^ b[i]));

/** Decrypt a `tauri signer generate` key (rsign2's scrypt-encrypted minisign secret key). */
export function parseSecretKey(privateKey, password) {
  const raw = unb64(boxLines(privateKey, 'TAURI_SIGNING_PRIVATE_KEY')[1]);
  if (raw.length !== 158 || raw.subarray(0, 2).toString() !== 'Ed' || raw.subarray(4, 6).toString() !== 'B2') {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY is not a minisign Ed25519 secret key');
  }
  const kdf = raw.subarray(2, 4).toString('latin1');
  let keyBox = raw.subarray(54, 158);
  if (kdf === 'Sc') {
    keyBox = xor(keyBox, kdfStream(password ?? '', raw.subarray(6, 38), raw.readBigUInt64LE(38), raw.readBigUInt64LE(46)));
  } else if (kdf !== '\0\0') {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY uses an unknown key derivation');
  }
  const keyId = keyBox.subarray(0, 8);
  const secret = keyBox.subarray(8, 72);
  const checksum = blake2b(Buffer.concat([Buffer.from('Ed'), keyId, secret]), 32);
  if (!checksum.equals(keyBox.subarray(72, 104))) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY does not decrypt with TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
  }
  return { keyId, seed: secret.subarray(0, 32), publicKey: secret.subarray(32, 64) };
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const edPrivate = seed => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
const edPublic = key => createPublicKey({ key: Buffer.concat([SPKI_ED25519, key]), format: 'der', type: 'spki' });

/**
 * The .sig content for `data` (base64 of the minisign signature file), in `tauri signer sign`'s format. The bytes of
 * the Ed25519 signatures differ (the CLI's are hedged with random noise, Node's are deterministic); both verify. The
 * trusted comment adds `version:<version>`, which the app requires (requireSignedVersion).
 */
export function signUpdate(data, { secret, fileName, version, timestamp = Math.floor(Date.now() / 1000) }) {
  const key = edPrivate(secret.seed);
  const signature = edSign(null, createHash('blake2b512').update(data).digest(), key);
  const trusted = `timestamp:${timestamp}\tfile:${fileName}\tversion:${version}`;
  const global = edSign(null, Buffer.concat([signature, Buffer.from(trusted, 'utf8')]), key);
  return b64([
    'untrusted comment: signature from tauri secret key',
    b64(Buffer.concat([Buffer.from('ED'), secret.keyId, signature])),
    `trusted comment: ${trusted}`,
    b64(global),
    '',
  ].join('\n'));
}

/** minisign verification as the app's updater does it (prehashed or legacy); returns the signed trusted comment. */
export function verifySignature(data, sig, pubkey) {
  const { keyId, publicKey } = parsePublicKey(pubkey);
  const lines = boxLines(sig, 'The updater signature');
  const raw = unb64(lines[1]);
  const trustedLine = lines[2] ?? '';
  if (raw.length !== 74 || !trustedLine.startsWith('trusted comment: ')) throw new Error('The updater signature is malformed');
  if (!raw.subarray(2, 10).equals(keyId)) throw new Error('The updater signature was made by another key than the app trusts');
  const alg = raw.subarray(0, 2).toString();
  const message = alg === 'ED' ? createHash('blake2b512').update(data).digest() : alg === 'Ed' ? data : null;
  if (!message) throw new Error('The updater signature uses an unknown algorithm');
  const key = edPublic(publicKey);
  const signature = raw.subarray(10, 74);
  const trusted = trustedLine.slice('trusted comment: '.length);
  if (!edVerify(null, message, key, signature)) throw new Error('The updater signature does not match the archive');
  if (!edVerify(null, Buffer.concat([signature, Buffer.from(trusted, 'utf8')]), key, unb64(lines[3] ?? ''))) {
    throw new Error('The updater signature\'s trusted comment is not signed');
  }
  return trusted;
}

/** What the app's updater (tauri-plugin-updater with requireSignedVersion) checks before it installs anything. */
export function verifyUpdate(data, sig, pubkey, version) {
  const trusted = verifySignature(data, sig, pubkey);
  const signed = trusted.split('\t').find(field => field.startsWith('version:'))?.slice('version:'.length);
  if (signed !== version) throw new Error(`The updater signature is for version ${signed ?? '(none)'}, not ${version}`);
}

/** latest.json, Tauri's static update manifest. */
export function updateManifest({ version, notes, pubDate, url, signature }) {
  if (!VERSION.test(version)) throw new Error(`Not a desktop version: ${JSON.stringify(version)}`);
  if (!/^https:\/\/\S+\.app\.tar\.gz$/.test(url)) throw new Error(`The update URL must be an https .app.tar.gz, got ${JSON.stringify(url)}`);
  if (Number.isNaN(Date.parse(pubDate)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(pubDate)) {
    throw new Error(`pub_date must be RFC 3339 UTC, got ${JSON.stringify(pubDate)}`);
  }
  return { version, notes, pub_date: pubDate, platforms: { [PLATFORM]: { signature, url } } };
}

/** `tauri signer generate`'s scrypt limits (rsign2's): N=2^15, r=8, p=1. */
export const RELEASE_KDF = { opslimit: 1048576n, memlimit: 33554432n };
/** Lighter limits for the CI dry run's throwaway key. */
const DRY_RUN_KDF = { opslimit: 524288n, memlimit: 16777216n };

/** A key in `tauri signer generate`'s format: rsign2's scrypt-encrypted minisign Ed25519 secret key and its public key. */
export function generateKey(password, { seed = randomBytes(32), keyId = randomBytes(8), salt = randomBytes(32), kdf = DRY_RUN_KDF } = {}) {
  const jwk = edPrivate(seed).export({ format: 'jwk' });
  const publicKey = Buffer.from(jwk.x, 'base64url');
  const secret = Buffer.concat([seed, publicKey]);
  const checksum = blake2b(Buffer.concat([Buffer.from('Ed'), keyId, secret]), 32);
  const { opslimit, memlimit } = kdf;
  const limits = Buffer.alloc(16);
  limits.writeBigUInt64LE(opslimit, 0);
  limits.writeBigUInt64LE(memlimit, 8);
  const keyBox = xor(Buffer.concat([keyId, secret, checksum]), kdfStream(password, salt, opslimit, memlimit));
  const id = Buffer.from(keyId).reverse().toString('hex').toUpperCase();
  return {
    privateKey: b64(`untrusted comment: rsign encrypted secret key\n${b64(Buffer.concat([Buffer.from('EdScB2'), salt, limits, keyBox]))}\n`),
    pubkey: b64(`untrusted comment: minisign public key: ${id}\n${b64(Buffer.concat([Buffer.from('Ed'), keyId, publicKey]))}\n`),
  };
}

function signCommand(values) {
  const { archive, version, pubkey } = values;
  if (!archive || !version || !pubkey) throw new Error('sign needs --archive, --version and --pubkey');
  if (!VERSION.test(version)) throw new Error(`Not a desktop version: ${JSON.stringify(version)}`);
  const trusted = parsePublicKey(pubkey);
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('TAURI_SIGNING_PRIVATE_KEY is not set');
  const secret = parseSecretKey(process.env.TAURI_SIGNING_PRIVATE_KEY, process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD);
  if (!secret.publicKey.equals(trusted.publicKey) || !secret.keyId.equals(trusted.keyId)) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY is not the key whose public key the app trusts (tauri.conf.json plugins.updater.pubkey)');
  }
  const data = readFileSync(archive);
  const sig = signUpdate(data, { secret, fileName: basename(archive), version });
  verifyUpdate(data, sig, pubkey, version);
  writeFileSync(`${archive}.sig`, sig);
  console.log(`Signed ${basename(archive)} for ${version} with updater key ${Buffer.from(trusted.keyId).reverse().toString('hex').toUpperCase()}`);
}

function manifestCommand(values) {
  const { archive, version, pubkey, url, notes, out } = values;
  if (!archive || !values.signature || !version || !pubkey || !url || !notes || !out) {
    throw new Error('manifest needs --archive, --signature, --version, --pubkey, --url, --notes and --out');
  }
  const signature = readFileSync(values.signature, 'utf8').trim();
  verifyUpdate(readFileSync(archive), signature, pubkey, version);
  const pubDate = values['pub-date'] ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const manifest = updateManifest({ version, notes: readFileSync(notes, 'utf8'), pubDate, url, signature });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${basename(out)}: ${version} for ${PLATFORM} at ${url}`);
}

function keygenCommand(values) {
  if (!values.dir) throw new Error('keygen needs --dir');
  mkdirSync(values.dir, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString('base64url');
  const { privateKey, pubkey } = generateKey(password);
  for (const [name, content] of [['updater.key', privateKey], ['password', password]]) {
    writeFileSync(join(values.dir, name), content, { mode: 0o600 });
    chmodSync(join(values.dir, name), 0o600);
  }
  console.log(pubkey);
}

function generateCommand(values) {
  const { dir } = values;
  const file = values['password-file'];
  if (!dir || !file) throw new Error('generate needs --dir and --password-file (a 0600 file, or - for stdin)');
  if (file !== '-' && (statSync(file).mode & 0o077) !== 0) throw new Error(`${file} is readable by others than its owner: chmod 600 it`);
  const password = readFileSync(file === '-' ? 0 : file, 'utf8');
  if (password.length < 16) throw new Error('The key password must be at least 16 characters');
  if (password !== password.trim()) {
    throw new Error('The key password starts or ends with whitespace (a trailing newline?): store exactly what the secret will hold');
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey, pubkey } = generateKey(password, { kdf: RELEASE_KDF });
  // Re-read the key as `sign` will (same decryption and checksum) before anything is written.
  if (!parseSecretKey(privateKey, password).publicKey.equals(parsePublicKey(pubkey).publicKey)) throw new Error('Generated key does not round-trip');
  // 'wx': never overwrite an existing key.
  writeFileSync(join(dir, 'updater.key'), privateKey, { mode: 0o600, flag: 'wx' });
  chmodSync(join(dir, 'updater.key'), 0o600);
  writeFileSync(join(dir, 'updater.key.pub'), pubkey, { mode: 0o644, flag: 'wx' });
  console.log(pubkey);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(['archive', 'signature', 'version', 'pubkey', 'url', 'notes', 'out', 'pub-date', 'dir', 'password-file'].map(name => [name, { type: 'string' }])),
  });
  const commands = { sign: signCommand, manifest: manifestCommand, generate: generateCommand, keygen: keygenCommand };
  if (!commands[command]) throw new Error(`Usage: desktop-updater.mjs <${Object.keys(commands).join('|')}> [options]`);
  commands[command](values);
}
