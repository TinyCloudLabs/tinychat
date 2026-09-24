import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url));
const owner = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';
const permissions = JSON.parse(await readFile(new URL('../assets/permissions.json', import.meta.url))).permissions.map(p => ({ ...p, reason: 'Read existing application meetings & verify "scope". '.repeat(15) }));
const authorizationUrl = 'https://openkey.example.test/delegate?did=did%3Akey%3AzFixture%23zFixture&space=applications&permissions=' + encodeURIComponent(JSON.stringify(permissions)) + '&nonce=synthetic%2Fnonce%2Bvalue&note=$(never-run);`never-run`';
async function fixture(t, opener = 'success') {
  const dir = await mkdtemp(join(tmpdir(), 'tinychat-login-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tc = join(dir, 'tc');
  const receipt = join(dir, 'receipt.json');
  const authenticated = join(dir, 'authenticated');
  await writeFile(tc, `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2);
const authenticated=${JSON.stringify(authenticated)};
if(args.includes('--version')) console.log('0.10.0');
else if(args.includes('list')) console.log(JSON.stringify({profiles:fs.existsSync(${JSON.stringify(join(dir, 'profile'))})?[{name:'tinychat-agent',host:'https://node.example.test'}]:[]}));
else if(args.includes('create')) {fs.writeFileSync(${JSON.stringify(join(dir, 'profile'))},'');console.log('{}');}
else if(args.includes('context')) console.log(JSON.stringify({schemaVersion:1,profile:'tinychat-agent',host:'https://node.example.test',sessionDid:'did:key:zTest',ownerDid:fs.existsSync(authenticated)?${JSON.stringify(owner)}:null,spaceId:args.includes('--space')?'tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications':null,session:fs.existsSync(authenticated)?{state:'present',expiresAt:'2099-01-01T00:00:00.000Z'}:{state:'missing'}}));
else if(args.includes('login')) {
  if(!args.includes('--paste')) throw new Error('Agent flow must use paste transport');
  process.stderr.write('Open this URL in a browser to authenticate:\\n\\n  '+${JSON.stringify(authorizationUrl)}+'\\n\\nPaste delegation code: ');
  let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
  process.stdin.on('end',()=>{
    fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({args,input}));
    const parsed=JSON.parse(input);
    if(parsed.reject) {console.error(JSON.stringify({error:{code:typeof parsed.reject==='string'?parsed.reject:'OWNER_MISMATCH',message:'PRIVATE '+input}}));process.exitCode=3;}
    else {fs.writeFileSync(authenticated,'');console.log(JSON.stringify({authenticated:true,privateResponse:input}));}
  });
} else throw new Error('Unexpected CLI invocation');
`, { mode: 0o700 });
  const opened = join(dir, 'opened.json');
  await symlink(process.execPath, join(dir, 'node'));
  for (const name of opener === 'missing' ? [] : ['open', 'xdg-open']) await writeFile(join(dir, name), `#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(opened)},JSON.stringify(process.argv.slice(2)));
${opener === 'failure' ? "console.error('PRIVATE_URL '+process.argv.at(-1));process.exit(2);" : opener === 'hang' ? 'setInterval(()=>{},1000);' : ''}
`, { mode: 0o700 });
  const env = { ...process.env, TMPDIR: dir, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config'), PATH: dir };
  const config = join(dir, 'app.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, host: 'https://node.example.test', space: 'applications', expectedOwner: owner }));
  const run = args => exec(process.execPath, [entry, ...args], { env, timeout: 12000 }).catch(e => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));
  assert.equal(JSON.parse((await run(['prepare', '--config', config])).stdout).status, 'login-required');
  return { dir, receipt, authenticated, opened, run, env };
}

test('authorize delivers exact encoded permissions to a browser process without exposing the URL', async t => {
  const { run, opened } = await fixture(t);
  const result = await run(['authorize']);
  assert.equal(result.code, undefined, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.status, 'awaiting-approval');
  assert.equal(value.authorizationUrl, undefined);
  assert.equal(value.delivery.status, 'launch-requested');
  assert.equal(value.delivery.instructions, 'Complete sign-in in the browser, then paste the code here.');
  assert.doesNotMatch(value.delivery.instructions, /remote|headless|transfer|download|cannot|delete/i);
  assert.deepEqual(JSON.parse(await readFile(opened, 'utf8')), [authorizationUrl]);
  const target = JSON.parse(await readFile(opened, 'utf8'))[0];
  assert.deepEqual(JSON.parse(new URL(target).searchParams.get('permissions')), permissions);
  assert.ok(!result.stdout.includes('permissions=') && !result.stderr.includes('permissions='));
  await assertArtifact(value.delivery);
  assert.equal(JSON.parse((await run(['context'])).stdout).status, 'login-required');
  await assertArtifact(value.delivery);
});

async function assertArtifact(delivery) {
  const html = await readFile(delivery.artifactPath, 'utf8');
  const target = html.match(/href="([^"]+)"/)[1].replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  assert.equal(target, authorizationUrl);
  assert.equal((await stat(delivery.artifactPath)).mode & 0o777, 0o600);
  assert.match(delivery.lifetime, /until.*delete/i);
  return html;
}

test('headless delivery is a private transferable artifact, never a localhost URL or browser launch', async t => {
  const { run, opened } = await fixture(t);
  const result = await run(['authorize', '--delivery', 'file']);
  assert.equal(result.code, undefined, result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.status, 'awaiting-approval');
  assert.equal(value.delivery.status, 'file-created');
  assert.equal(value.authorizationUrl, undefined);
  assert.match(value.delivery.instructions, /remote.*download|remote.*transfer/i);
  assert.match(value.delivery.instructions, /paste the code here/i);
  assert.match(value.delivery.instructions, /keep.*pending/i);
  const html = await assertArtifact(value.delivery);
  await assert.rejects(stat(opened), { code: 'ENOENT' });
  // File outlives the authorize process and can be copied byte-for-byte to the user's machine.
  const copy = value.delivery.artifactPath + '.downloaded.html';
  await writeFile(copy, html, { mode: 0o600 });
  assert.equal(await readFile(copy, 'utf8'), html);
  await rm(value.delivery.artifactPath);
  await assert.rejects(stat(value.delivery.artifactPath), { code: 'ENOENT' });
});

test('failed browser launch is an actionable nonzero result with a working artifact and no URL leak', async t => {
  const { run } = await fixture(t, 'failure');
  const result = await run(['authorize']);
  assert.equal(result.code, 1);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, false);
  assert.equal(value.error.code, 'BROWSER_OPEN_FAILED');
  assert.match(value.error.message, /open.*locally/i);
  assert.doesNotMatch(value.error.message, /download|transfer|remote|headless/i);
  assert.match(value.delivery.instructions, /open.*locally/i);
  assert.doesNotMatch(value.delivery.instructions, /download|transfer|remote|headless/i);
  assert.match(value.delivery.instructions, /keep.*pending/i);
  await assertArtifact(value.delivery);
  assert.ok(!result.stdout.includes('permissions=') && !result.stderr.includes('permissions='));
  assert.equal(JSON.parse((await run(['context'])).stdout).status, 'login-required');
  await assertArtifact(value.delivery);
});

test('complete response reaches CLI stdin intact, keeps scope/owner and returns only verified context', async t => {
  const { dir, receipt, run } = await fixture(t);
  const value = { delegationHeader: { Authorization: 'SECRET'.repeat(2000) }, text: '$(never-run); `never-run`', reject: false };
  const file = join(dir, 'response');
  await writeFile(file, Buffer.from(JSON.stringify(value)).toString('base64'), { mode: 0o600 });
  const result = await run(['login', '--code-file', file]);
  assert.equal(result.code, undefined, result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'ready');
  const observed = JSON.parse(await readFile(receipt, 'utf8'));
  assert.deepEqual(JSON.parse(observed.input), value);
  assert.equal(observed.args[observed.args.indexOf('--owner') + 1], owner);
  assert.ok(observed.args.includes('--manifest'));
  assert.ok(!JSON.stringify(observed.args).includes('SECRET'));
  assert.ok(!result.stdout.includes('SECRET') && !result.stderr.includes('SECRET'));
  assert.equal(JSON.parse((await run(['authorize'])).stdout).status, 'ready');
});

test('truncated code fails before login and CLI rejections remain failures without leaking a grant', async t => {
  const { dir, run } = await fixture(t);
  const file = join(dir, 'response');
  await writeFile(file, 'eyJ...<TRUNCATED>', { mode: 0o600 });
  const invalid = await run(['login', '--code-file', file]);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_AUTH_RESPONSE');
  await writeFile(file, JSON.stringify({ reject: true, secret: 'NEVER_ECHO_THIS' }));
  const rejected = await run(['login', '--code-file', file]);
  assert.equal(rejected.code, 1);
  assert.equal(JSON.parse(rejected.stdout).error.code, 'OWNER_MISMATCH');
  assert.ok(!rejected.stdout.includes('NEVER_ECHO_THIS') && !rejected.stderr.includes('NEVER_ECHO_THIS'));
  assert.equal(JSON.parse((await run(['context'])).stdout).status, 'login-required');
});

test('distinct CLI verification failures survive without exposing opaque response data', async t => {
  const { dir, run } = await fixture(t);
  const file = join(dir, 'response');
  for (const code of ['OPENKEY_PROOF_INVALID', 'OPENKEY_SCOPE_MISMATCH', 'OPENKEY_GRANT_BROADENED', 'AUTH_EXPIRED']) {
    await writeFile(file, JSON.stringify({ reject: code, Authorization: 'PRIVATE_GRANT' }), { mode: 0o600 });
    const result = await run(['login', '--code-file', file]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error.code, code);
    assert.ok(!result.stdout.includes('PRIVATE_GRANT') && !result.stderr.includes('PRIVATE_GRANT'));
  }
});

// The real opener timeout is five seconds; allow it to complete before asserting the ten-second bound.
for (const opener of ['missing', 'hang']) test(`${opener} opener fails promptly with an intact file handoff`, { timeout: 12000 }, async t => {
  const { run } = await fixture(t, opener);
  const started = Date.now();
  const result = await run(['authorize']);
  assert.equal(result.code, 1);
  assert.ok(Date.now() - started < 10000);
  const value = JSON.parse(result.stdout);
  assert.equal(value.error.code, 'BROWSER_OPEN_FAILED');
  await assertArtifact(value.delivery);
});

test('OpenCode original chat input reaches the actual setup normalizer and CLI stdin without code arguments', async t => {
  const { dir, receipt, env } = await fixture(t);
  const script = join(dir, 'client-boundary.mjs');
  const plugin = new URL('../lib/opencode-plugin.mjs', import.meta.url).href;
  const setup = new URL('../lib/setup.mjs', import.meta.url).href;
  const manifest = fileURLToPath(new URL('../assets/permissions.json', import.meta.url));
  await writeFile(script, `
import { createSigninHooks } from ${JSON.stringify(plugin)};
import { createSetup } from ${JSON.stringify(setup)};
const hooks = createSigninHooks({setup: createSetup({statePath: ${JSON.stringify(join(dir, '.config/tinychat-retrieval/setup.json'))}, manifestPath: ${JSON.stringify(manifest)}})});
await hooks.tool.tinychat_authorize.execute({}, {sessionID: 'synthetic-session'});
const original = Buffer.from(JSON.stringify({delegationHeader: {Authorization: 'boundary-stream-secret-'.repeat(320)}, edge: '>>>>>>??????'})).toString('base64')+' ';
const output = {message: {id: 'original-user-message', sessionID: 'synthetic-session'}, parts: [{type: 'text', text: original}]};
await hooks['chat.message']({sessionID: 'synthetic-session'}, output);
console.log(output.parts[0].text);
`, { mode: 0o600 });
  const result = await exec(process.execPath, [script], { env, timeout: 12000 });
  assert.match(result.stdout, /"status":"ready"/);
  assert.ok(!result.stdout.includes('boundary-stream-secret-'));
  assert.ok(!result.stderr.includes('boundary-stream-secret-'));
  const observed = JSON.parse(await readFile(receipt, 'utf8'));
  assert.deepEqual(JSON.parse(observed.input), { delegationHeader: { Authorization: 'boundary-stream-secret-'.repeat(320) }, edge: '>>>>>>??????' });
  assert.ok(!JSON.stringify(observed.args).includes('boundary-stream-secret-'));
  assert.ok(observed.args.includes('--paste'));
  assert.ok(observed.args.includes('--manifest'));
});
