import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rename, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TINYCHAT_CAPS } from '../lib/setup.mjs';

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url));
const owner = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';
const approvalUrl = 'https://openkey.example.test/delegate?did=did%3Akey%3AzFixture&space=applications&nonce=synthetic%2Fnonce%2Bvalue&note=$(never-run);`never-run`';

/** A fake `tinycloud` with an onboarded default profile that lacks TinyChat's reads until a code is pasted. */
async function fixture(t, { install = 'TC_BIN' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tinychat-login-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const cli = join(bin, 'tinycloud');
  const receipt = join(dir, 'receipt.json');
  const granted = join(dir, 'granted');
  const tcCalled = join(dir, 'tc-called');
  await writeFile(cli, `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2);
const granted=${JSON.stringify(granted)};
if(args.includes('--version')) console.log('1.5.0-beta.28');
else if(args.includes('list')) console.log(JSON.stringify({profiles:[{name:'default',host:'https://tee.node.tinycloud.xyz'}]}));
else if(args.includes('context')) console.log(JSON.stringify({schemaVersion:1,profile:'default',host:'https://tee.node.tinycloud.xyz',sessionDid:'did:key:zTest',ownerDid:${JSON.stringify(owner)},spaceId:args.includes('--space')?'tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications':null,session:{state:'present',expiresAt:'2099-01-01T00:00:00.000Z'}}));
else if(args.includes('caps')) console.log(JSON.stringify({covered:fs.existsSync(granted)}));
else if(args.includes('request')) {
  if(!args.includes('--grant') || !args.includes('--paste')) throw new Error('Agent flow must use --grant --paste');
  if(fs.existsSync(granted)) { console.log(JSON.stringify({changed:false,missing:[],added:[]})); return; }
  process.stderr.write('\\nOpen this URL in a browser to authenticate:\\n\\n  '+${JSON.stringify(approvalUrl)}+'\\n\\nEnter short code or paste full delegation code: ');
  let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
  process.stdin.on('end',()=>{
    if(!input.trim()) { console.error(JSON.stringify({error:{code:'PASTE_CODE_MISSING',message:'no code'}})); process.exitCode=3; return; }
    fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({args,input}));
    const code=input.trim();
    const reject=code.startsWith('{')?JSON.parse(code).reject:code.toLowerCase()==='zzzz-zzzz'?'OPENKEY_PROOF_INVALID':false;
    if(reject) {console.error(JSON.stringify({error:{code:typeof reject==='string'?reject:'OWNER_MISMATCH',message:'PRIVATE '+input}}));process.exitCode=3;}
    else {fs.writeFileSync(granted,'');console.log(JSON.stringify({changed:true}));}
  });
} else throw new Error('Unexpected CLI invocation');
`, { mode: 0o700 });
  // A traffic-control style `tc` on PATH must never run.
  await writeFile(join(bin, 'tc'), `#!/bin/sh\ntouch ${JSON.stringify(tcCalled)}\nexit 1\n`, { mode: 0o700 });
  for (const opener of ['open', 'xdg-open']) await writeFile(join(bin, opener), `#!/bin/sh\ntouch ${JSON.stringify(join(dir, 'opened'))}\n`, { mode: 0o700 });
  await symlink(process.execPath, join(bin, 'node'));
  const tmp = join(dir, 'tmp');
  await mkdir(tmp);
  const env = { ...process.env, TMPDIR: tmp, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), PATH: bin };
  delete env.TC_PROFILE;
  if (install === 'TC_BIN') env.TC_BIN = cli; else delete env.TC_BIN;
  const config = join(dir, 'app.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, host: 'https://tee.node.tinycloud.xyz', space: 'applications' }));
  const run = (args, input) => new Promise(resolve => {
    const child = spawn(process.execPath, [entry, ...args], { env, timeout: 12000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ stdout, stderr, code: code || undefined }));
    child.stdin.end(input);
  });
  return { dir, bin, cli, receipt, granted, tmp, tcCalled, run, env, config };
}
const parse = result => JSON.parse(result.stdout);

test('prepare binds default, then authorize returns the OpenKey link and one line, with no browser or file', { timeout: 30000 }, async t => {
  const { run, config, dir, tmp, tcCalled } = await fixture(t);
  const prepared = parse(await run(['prepare', '--config', config]));
  assert.equal(prepared.status, 'access-required');
  assert.equal(prepared.profile, 'default');
  const result = await run(['authorize']);
  assert.equal(result.code, undefined, result.stdout);
  const value = parse(result);
  assert.equal(value.status, 'awaiting-approval');
  assert.equal(value.approvalUrl, approvalUrl);
  assert.equal(value.message, 'Open this link and approve TinyChat access, then send me the short code OpenKey shows (like ABCD-EFGH).');
  assert.equal(value.delivery, undefined);
  assert.deepEqual(await readdir(tmp), [], 'no approval file');
  await assert.rejects(readFile(join(dir, 'opened')), { code: 'ENOENT' });
  await assert.rejects(readFile(tcCalled), { code: 'ENOENT' });
});

for (const via of ['--code', 'stdin']) test(`a short code pasted in chat (${via}) reaches auth request --grant --paste stdin exactly`, { timeout: 30000 }, async t => {
  const { run, receipt, tcCalled } = await fixture(t);
  await run(['authorize']);
  const result = via === '--code' ? await run(['login', '--code', ' AbCd-2345 ']) : await run(['login'], 'AbCd-2345\n');
  assert.equal(result.code, undefined, result.stdout);
  assert.equal(parse(result).status, 'ready');
  const observed = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(observed.input, 'AbCd-2345\n');
  assert.deepEqual(observed.args, ['--profile', 'default', '--host', 'https://tee.node.tinycloud.xyz', 'auth', 'request', ...TINYCHAT_CAPS.flatMap(cap => ['--cap', cap]), '--grant', '--paste', '--expiry', '30d']);
  assert.equal(parse(await run(['authorize'])).status, 'ready');
  await assert.rejects(readFile(tcCalled), { code: 'ENOENT' });
});

test('a full JSON or base64 code still reaches CLI stdin intact', { timeout: 30000 }, async t => {
  const { receipt, run } = await fixture(t);
  const value = { delegationHeader: { Authorization: 'PERMISSION_SLIP'.repeat(200) }, text: '$(never-run); `never-run`' };
  const result = await run(['login'], Buffer.from(JSON.stringify(value)).toString('base64'));
  assert.equal(parse(result).status, 'ready', result.stdout);
  assert.deepEqual(JSON.parse(JSON.parse(await readFile(receipt, 'utf8')).input), value);
});

test('an unusable code fails before the CLI; CLI rejections keep their codes without echoing input', { timeout: 30000 }, async t => {
  const { run, receipt } = await fixture(t);
  for (const bad of ['ABCD-EFG', 'eyJ...<TRUNCATED>']) {
    assert.equal(parse(await run(['login', '--code', bad])).error.code, 'INVALID_AUTH_RESPONSE');
  }
  await assert.rejects(readFile(receipt), { code: 'ENOENT' });
  const proof = await run(['login', '--code', 'zzzz-zzzz']);
  assert.equal(proof.code, 1);
  assert.equal(parse(proof).error.code, 'OPENKEY_PROOF_INVALID');
  for (const code of ['OWNER_MISMATCH', 'OPENKEY_SCOPE_MISMATCH', 'OPENKEY_GRANT_BROADENED', 'AUTH_EXPIRED']) {
    const result = await run(['login'], JSON.stringify({ reject: code === 'OWNER_MISMATCH' ? true : code, secret: 'NEVER_ECHO_THIS' }));
    assert.equal(result.code, 1);
    assert.equal(parse(result).error.code, code);
    assert.ok(!result.stdout.includes('NEVER_ECHO_THIS') && !result.stderr.includes('NEVER_ECHO_THIS'));
  }
  assert.equal(parse(await run(['prepare'])).status, 'access-required');
});

test('removed private-file and OpenCode-only options are refused', { timeout: 30000 }, async t => {
  const { run, env } = await fixture(t);
  assert.match(parse(await run(['login', '--code-file', '/tmp/code'])).error.message, /--help|Unknown option/);
  assert.match(parse(await run(['authorize', '--delivery', 'file'])).error.message, /--help|Unknown option/);
  env.OPENCODE = '1';
  assert.equal(parse(await run(['authorize'])).status, 'awaiting-approval', 'the same path works inside OpenCode');
});

test('the CLI is TC_BIN, else the onboarding install, else tinycloud on PATH, never tc', { timeout: 30000 }, async t => {
  const onPath = await fixture(t, { install: 'PATH' });
  assert.equal(parse(await onPath.run(['prepare'])).status, 'access-required');
  const installed = await fixture(t, { install: 'none' });
  const shared = join(installed.dir, '.local/share/tinycloud/cli/node_modules/.bin');
  await mkdir(shared, { recursive: true });
  await rename(installed.cli, join(shared, 'tinycloud'));
  assert.equal(parse(await installed.run(['prepare'])).status, 'access-required');
  await rm(join(shared, 'tinycloud'));
  assert.equal(parse(await installed.run(['prepare'])).error.code, 'CLI_UNAVAILABLE');
  for (const f of [onPath, installed]) await assert.rejects(readFile(f.tcCalled), { code: 'ENOENT' }, 'never falls back to tc');
});

test('OpenCode tinychat_authorize takes the pasted code as an argument and uses the same CLI stdin path', { timeout: 30000 }, async t => {
  const { dir, receipt, env } = await fixture(t);
  const script = join(dir, 'client-boundary.mjs');
  const plugin = new URL('../lib/opencode-plugin.mjs', import.meta.url).href;
  const setup = new URL('../lib/setup.mjs', import.meta.url).href;
  await writeFile(script, `
import { createSigninHooks } from ${JSON.stringify(plugin)};
import { createSetup } from ${JSON.stringify(setup)};
const hooks = createSigninHooks({setup: createSetup({statePath: ${JSON.stringify(join(dir, '.config/tinychat-retrieval/setup.json'))}})});
console.log(await hooks.tool.tinychat_authorize.execute({}, {sessionID: 'synthetic-session'}));
console.log(await hooks.tool.tinychat_authorize.execute({code: 'WXYZ-7654'}, {sessionID: 'synthetic-session'}));
`, { mode: 0o600 });
  const result = await exec(process.execPath, [script], { env, timeout: 12000 });
  const [link, verified] = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(link.approvalUrl, approvalUrl);
  assert.equal(verified.status, 'ready');
  assert.equal(JSON.parse(await readFile(receipt, 'utf8')).input, 'WXYZ-7654\n');
});
