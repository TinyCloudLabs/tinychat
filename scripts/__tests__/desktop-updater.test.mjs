import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_KDF, blake2b, generateKey, parsePublicKey, parseSecretKey, signUpdate, verifySignature, verifyUpdate } from '../release/desktop-updater.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '../release/desktop-updater.mjs');
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/desktop-updater-signature.json'), 'utf8'));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-updater-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: '', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '', ...env },
  });
}

/** A key from the script's dry-run keygen, as desktop-build.yml's CI sign job makes it. */
function dryRunKey(t) {
  const dir = tempDir(t);
  const result = run(['keygen', '--dir', join(dir, 'key')]);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['updater.key', 'password']) assert.equal(statSync(join(dir, 'key', name)).mode & 0o777, 0o600);
  return {
    dir,
    pubkey: result.stdout.trim(),
    env: {
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(join(dir, 'key/updater.key'), 'utf8'),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: readFileSync(join(dir, 'key/password'), 'utf8'),
    },
  };
}

test('BLAKE2b matches the reference digests (secret key checksum)', () => {
  for (const input of ['', 'abc', 'x'.repeat(300)]) {
    assert.equal(blake2b(Buffer.from(input), 64).toString('hex'), createHash('blake2b512').update(input).digest('hex'));
  }
  assert.equal(blake2b(Buffer.alloc(0), 32).toString('hex'), '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8');
});

// The Rust side (desktop/src-tauri/src/desktop_update.rs) verifies this same fixture with minisign-verify, the
// verifier tauri-plugin-updater uses, so the signer and the app's verifier agree on every byte of the format.
test('signatures are deterministic and equal the fixture the app verifies', () => {
  const { privateKey } = generateKey('fixture', { seed: Buffer.alloc(32, 1), keyId: Buffer.from('0102030405060708', 'hex'), salt: Buffer.alloc(32, 2) });
  const signature = signUpdate(Buffer.from(fixture.data), {
    secret: parseSecretKey(privateKey, 'fixture'),
    fileName: fixture.fileName,
    version: fixture.version,
    timestamp: fixture.timestamp,
  });
  assert.equal(signature, fixture.signature);
  verifyUpdate(Buffer.from(fixture.data), fixture.signature, fixture.pubkey, fixture.version);
});

// Known answer from the real tool: fixtures/desktop-updater-tauri-cli was made once, offline, with tauri-cli 2.11.4
// (desktop's @tauri-apps/cli): `tauri signer generate --ci -w test-only.key -p test-only-password` (a test-only key,
// never trusted by any build) and `tauri signer sign -f test-only.key -p test-only-password payload.bin`.
test('the script reads tauri signer keys and signatures, and writes signatures in the same format', () => {
  const dir = join(here, 'fixtures/desktop-updater-tauri-cli');
  const cliKey = readFileSync(join(dir, 'test-only.key'), 'utf8');
  const cliPub = readFileSync(join(dir, 'test-only.key.pub'), 'utf8');
  const cliSig = readFileSync(join(dir, 'payload.bin.sig'), 'utf8');
  const payload = readFileSync(join(dir, 'payload.bin'));
  // scrypt decryption and the BLAKE2b-256 checksum: the decrypted key is the CLI's public key's.
  const secret = parseSecretKey(cliKey, 'test-only-password');
  const pub = parsePublicKey(cliPub);
  assert.ok(secret.keyId.equals(pub.keyId) && secret.publicKey.equals(pub.publicKey));
  assert.throws(() => parseSecretKey(cliKey, 'wrong'), /does not decrypt/);
  // The CLI's prehashed signature verifies; a changed payload does not.
  assert.match(verifySignature(payload, cliSig, cliPub), /^timestamp:\d+\tfile:/);
  assert.throws(() => verifySignature(Buffer.concat([payload, Buffer.from('x')]), cliSig, cliPub), /does not match the archive/);
  // The script's signature with the CLI's key: same box, algorithm and key id lines; verifies against the CLI's key.
  const ours = signUpdate(payload, { secret, fileName: 'payload.bin', version: '1.2.3', timestamp: 1700000000 });
  verifyUpdate(payload, ours, cliPub, '1.2.3');
  const lines = sig => Buffer.from(sig, 'base64').toString('utf8').split('\n');
  const [cliLines, ourLines] = [lines(cliSig), lines(ours)];
  assert.equal(ourLines[0], cliLines[0]);
  assert.ok(Buffer.from(ourLines[1], 'base64').subarray(0, 10).equals(Buffer.from(cliLines[1], 'base64').subarray(0, 10)));
  assert.equal(ourLines.length, cliLines.length);
});

// The other direction: the CLI uses a key the script generated. fixtures/desktop-updater-generated/test-only.key is
// generateKey('test-only-generated-password', { seed: 32 × 0x03, keyId: 1112131415161718, salt: 32 × 0x04,
// kdf: RELEASE_KDF }); payload.bin.sig is tauri-cli 2.11.4's
// `tauri signer sign -f test-only.key -p test-only-generated-password payload.bin` (the CLI refuses a wrong password).
test('tauri signer sign accepts a key the script generates for release', () => {
  const dir = join(here, 'fixtures/desktop-updater-generated');
  const key = generateKey('test-only-generated-password', {
    seed: Buffer.alloc(32, 3), keyId: Buffer.from('1112131415161718', 'hex'), salt: Buffer.alloc(32, 4), kdf: RELEASE_KDF,
  });
  assert.equal(key.privateKey, readFileSync(join(dir, 'test-only.key'), 'utf8'));
  assert.equal(key.pubkey, readFileSync(join(dir, 'test-only.key.pub'), 'utf8'));
  assert.match(verifySignature(readFileSync(join(dir, 'payload.bin')), readFileSync(join(dir, 'payload.bin.sig'), 'utf8'), key.pubkey), /^timestamp:\d+\tfile:/);
});

test('generate reads the password from a private file or stdin, never from arguments, and never overwrites a key', t => {
  const dir = tempDir(t);
  const password = 'a-random-test-password-0123456789';
  const file = join(dir, 'password');
  writeFileSync(file, password, { mode: 0o600 });
  const fromFile = run(['generate', '--dir', join(dir, 'a'), '--password-file', file]);
  assert.equal(fromFile.status, 0, fromFile.stderr);
  assert.equal(statSync(join(dir, 'a/updater.key')).mode & 0o777, 0o600);
  assert.equal(fromFile.stdout.trim(), readFileSync(join(dir, 'a/updater.key.pub'), 'utf8'));
  const fromStdin = spawnSync(process.execPath, [script, 'generate', '--dir', join(dir, 'b'), '--password-file', '-'], { input: password, encoding: 'utf8' });
  assert.equal(fromStdin.status, 0, fromStdin.stderr);
  for (const sub of ['a', 'b']) {
    const secret = parseSecretKey(readFileSync(join(dir, sub, 'updater.key'), 'utf8'), password);
    assert.ok(secret.publicKey.equals(parsePublicKey(readFileSync(join(dir, sub, 'updater.key.pub'), 'utf8')).publicKey));
    const raw = Buffer.from(Buffer.from(readFileSync(join(dir, sub, 'updater.key'), 'utf8'), 'base64').toString('utf8').split('\n')[1], 'base64');
    assert.deepEqual([raw.readBigUInt64LE(38), raw.readBigUInt64LE(46)], [RELEASE_KDF.opslimit, RELEASE_KDF.memlimit]);
  }
  assert.match(run(['generate', '--dir', join(dir, 'a'), '--password-file', file]).stderr, /EEXIST/);
  const shared = join(dir, 'shared');
  writeFileSync(shared, password);
  chmodSync(shared, 0o644); // explicit: writeFileSync's mode is masked by the umask
  assert.match(run(['generate', '--dir', join(dir, 'c'), '--password-file', shared]).stderr, /readable by others/);
  writeFileSync(file, `${password}\n`);
  assert.match(run(['generate', '--dir', join(dir, 'd'), '--password-file', file]).stderr, /trailing newline/);
});

test('sign and manifest write a latest.json the app accepts', t => {
  const key = dryRunKey(t);
  const archive = join(key.dir, 'TinyCloud-One_1.4.0_aarch64.app.tar.gz');
  writeFileSync(archive, 'not really a tarball');
  writeFileSync(join(key.dir, 'notes.md'), '## Desktop\n\n- Updates itself.\n');
  const sign = run(['sign', '--archive', archive, '--version', '1.4.0', '--pubkey', key.pubkey], key.env);
  assert.equal(sign.status, 0, sign.stderr);
  assert.doesNotMatch(sign.stdout + sign.stderr, new RegExp(key.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD));

  const url = 'https://github.com/TinyCloudLabs/tinychat/releases/download/exo-desktop%401.4.0/TinyCloud-One_1.4.0_aarch64.app.tar.gz';
  const out = join(key.dir, 'latest.json');
  const manifest = run(['manifest', '--archive', archive, '--signature', `${archive}.sig`, '--version', '1.4.0', '--pubkey', key.pubkey, '--url', url,
    '--notes', join(key.dir, 'notes.md'), '--out', out, '--pub-date', '2026-11-24T19:00:00Z']);
  assert.equal(manifest.status, 0, manifest.stderr);
  const latest = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(latest), ['version', 'notes', 'pub_date', 'platforms']);
  assert.equal(latest.version, '1.4.0');
  assert.equal(latest.notes, '## Desktop\n\n- Updates itself.\n');
  assert.equal(latest.pub_date, '2026-11-24T19:00:00Z');
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64']);
  assert.equal(latest.platforms['darwin-aarch64'].url, url);
  verifyUpdate(readFileSync(archive), latest.platforms['darwin-aarch64'].signature, key.pubkey, '1.4.0');
});

test('manifest refuses an archive that is not the signed one, or another version', t => {
  const key = dryRunKey(t);
  const archive = join(key.dir, 'TinyCloud-One_1.4.0_aarch64.app.tar.gz');
  writeFileSync(archive, 'signed bytes');
  writeFileSync(join(key.dir, 'notes.md'), 'notes');
  assert.equal(run(['sign', '--archive', archive, '--version', '1.4.0', '--pubkey', key.pubkey], key.env).status, 0);
  const manifest = version => run(['manifest', '--archive', archive, '--signature', `${archive}.sig`, '--version', version, '--pubkey', key.pubkey,
    '--url', 'https://github.com/o/r/releases/download/t/a.app.tar.gz', '--notes', join(key.dir, 'notes.md'), '--out', join(key.dir, 'latest.json')]);
  assert.match(manifest('1.5.0').stderr, /signature is for version 1\.4\.0, not 1\.5\.0/);
  writeFileSync(archive, 'tampered bytes');
  assert.match(manifest('1.4.0').stderr, /does not match the archive/);
});

test('sign refuses the placeholder pubkey, another key and a wrong password', t => {
  const key = dryRunKey(t);
  const other = dryRunKey(t);
  const archive = join(key.dir, 'a.app.tar.gz');
  writeFileSync(archive, 'bytes');
  const sign = (pubkey, env) => run(['sign', '--archive', archive, '--version', '1.4.0', '--pubkey', pubkey], env).stderr;
  assert.match(sign('PLACEHOLDER-TC-4275-mint-the-updater-key', key.env), /still the placeholder/);
  assert.match(sign(other.pubkey, key.env), /not the key whose public key the app trusts/);
  assert.match(sign(key.pubkey, { ...key.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'wrong' }), /does not decrypt/);
  assert.match(sign(key.pubkey, { TAURI_SIGNING_PRIVATE_KEY: '' }), /TAURI_SIGNING_PRIVATE_KEY is not set/);
});
