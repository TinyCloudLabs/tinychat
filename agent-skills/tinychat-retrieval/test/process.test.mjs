import { test, expect } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTcRunner } from '../lib/retrieval.mjs';
const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../scripts/retrieve.mjs', import.meta.url));

test('portable Node entry reports version and help without TinyCloud context', async () => {
  const version = await exec('node', [entry, '--version']).catch(e => ({ stdout: e.stdout, failed: true }));
  expect(version.failed).toBeUndefined(); expect(JSON.parse(version.stdout)).toMatchObject({ packVersion: '0.1.0', envelopeVersion: 1, nodeMinimum: '20.0.0' });
  const help = await exec('node', [entry, '--help']); expect(help.stdout).toContain('--owner'); expect(help.stdout).toContain('search');
});
test('command rejects unselected context and unsupported flags without a server request', async () => {
  const result = await exec('node', [entry, 'find']).catch(e => ({ stdout: e.stdout, code: e.code }));
  expect(result.code).toBe(1); expect(JSON.parse(result.stdout).error.code).toBe('INVALID_INPUT');
  const bad = await exec('node', [entry, 'find', '--unexpected', 'SECRET']).catch(e => ({ stdout: e.stdout, code: e.code }));
  expect(JSON.parse(bad.stdout).error.code).toBe('INVALID_INPUT'); expect(bad.stdout).not.toContain('SECRET');
});
test('process boundary passes shell-looking arguments literally', async () => {
  const run = createTcRunner({ executable: 'node' });
  const literal = '$(never-run); `never-run` "quoted"';
  expect(await run(['-e', 'process.stdout.write(process.argv.at(-1))', literal])).toBe(literal);
});
test('process boundary enforces stdout, deadline, cancellation and safe stderr', async () => {
  const small = createTcRunner({ executable: 'node', maxBuffer: 100 });
  await expect(small(['-e', 'process.stdout.write("x".repeat(1000))'])).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  const fast = createTcRunner({ executable: 'node', timeoutMs: 40 });
  await expect(fast(['-e', 'setTimeout(()=>{},1000)'])).rejects.toMatchObject({ code: 'TIMEOUT' });
  const abort = new AbortController(); const promise = fast(['-e', 'setTimeout(()=>{},1000)'], { signal: abort.signal }); abort.abort();
  await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(small(['-e', 'process.stderr.write(JSON.stringify({error:{code:"AUTH_EXPIRED",message:"PRIVATE"}}));process.exit(3)'])).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
});
test('real Node helper uses private output files and deletes them after success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tinychat-process-fixture-'));
  try {
    const stub = join(directory, 'tc-fixture'); const receipt = join(directory, 'receipt');
    await writeFile(stub, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if(args.includes('status')) {process.stdout.write(JSON.stringify({authenticated:true,ownerDid:'did:pkh:eip155:1:0x1111111111111111111111111111111111111111',profile:'fixture',host:'https://node.example.test'}));}
else if(args.includes('--version')) {process.stdout.write('0.10.0');}
else if(args.includes('query')) {process.stdout.write(JSON.stringify({columns:['id','source','source_id','title','started_at','organizer_email','participants','summary_overview','summary_action_items','metadata','updated_at','sort_time'],rows:[['id','fireflies','source','Title',null,null,'[]',null,null,'{}',null,null]],rowCount:1}));}
else if(args.includes('get')) {const output=args[args.indexOf('--output')+1];fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({directory:path.dirname(output),directoryMode:fs.statSync(path.dirname(output)).mode&511,fileMode:fs.statSync(output).mode&511,args}));fs.writeFileSync(output,JSON.stringify([{text:'Fixture body'}]));process.stdout.write('{}');}
`, { mode: 0o700 });
    const args = ['--profile', 'fixture', '--host', 'https://node.example.test', '--space', 'applications', '--owner', 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111', '--tc', stub];
    const result = await exec('node', [entry, 'diagnostics', ...args]);
    expect(JSON.parse(result.stdout).access.bodyRead).toBe(true);
    const r = JSON.parse(await readFile(receipt, 'utf8')); expect(r.directoryMode).toBe(0o700); expect(r.fileMode).toBe(0o600);
    expect(r.args).toContain('tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications');
    await expect(stat(r.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
