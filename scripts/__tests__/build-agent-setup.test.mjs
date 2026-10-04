import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = new URL('../../', import.meta.url);

async function build(t, args = [], env = {}) {
  const output = await mkdtemp(join(tmpdir(), 'tinychat-setup-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const childEnv = { ...process.env, ...env };
  if (!Object.hasOwn(env, 'VITE_TINYCLOUD_HOST')) delete childEnv.VITE_TINYCLOUD_HOST;
  const result = spawnSync(process.execPath, [new URL('../build-agent-setup.mjs', import.meta.url).pathname, '--output', output, ...args], { encoding: 'utf8', env: childEnv });
  return { output, result };
}
const decodeHtml = value => value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const pageContext = instructions => JSON.parse(instructions.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? '{}');
const expectedPrompt = 'How did my last meeting go? Check TinyCloud: https://tinycloud.chat/agents/setup.md';

test('public instructions, HTML and saved app context agree on pinned versions and production configuration', async t => {
  const { output, result } = await build(t);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(new URL('frontend/src/lib/agent-setup.json', root), 'utf8'));
  const production = await readFile(new URL('frontend/.env.production', root), 'utf8');
  const productionHost = production.match(/^VITE_TINYCLOUD_HOST=(.+)$/m)?.[1];
  const prompt = await readFile(join(output, 'prompt.txt'), 'utf8');
  assert.equal(prompt, expectedPrompt + '\n');
  assert.deepEqual(JSON.parse(await readFile(join(output, 'context.json'), 'utf8')), { schemaVersion: 1, host: productionHost, space: 'applications' });
  const md = await readFile(join(output, 'setup.md'), 'utf8');
  assert.deepEqual(pageContext(md), JSON.parse(await readFile(join(output, 'context.json'), 'utf8')));
  assert.ok(md.includes(`@tinycloud/cli@${config.cliVersion}`));
  assert.ok(md.includes(`tinychat-retrieval/${config.packVersion}/tinychat-retrieval-${config.packVersion}.tgz`));
  assert.ok(!md.includes('{{'));
  const html = await readFile(join(output, 'index.html'), 'utf8');
  assert.equal(decodeHtml(html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1]), prompt.trimEnd());
  assert.ok(!html.includes('type="module"'), 'public onboarding is independent of signed-in app JS');
  const redirects = await readFile(new URL('frontend/public/_redirects', root), 'utf8');
  assert.ok(redirects.indexOf('/agents/*') < redirects.indexOf('/*    /index.html'), 'public files must take priority over SPA catch-all');
});

test('loopback artifact URL remains independent from the configured TinyCloud data host', async t => {
  const { output, result } = await build(t, ['--host', 'https://custom.example', '--setup-base-url', 'http://127.0.0.1:6199/agents']);
  assert.equal(result.status, 0, result.stderr);
  const prompt = await readFile(join(output, 'prompt.txt'), 'utf8');
  assert.equal(prompt, 'How did my last meeting go? Check TinyCloud: http://127.0.0.1:6199/agents/setup.md\n');
  assert.deepEqual(JSON.parse(await readFile(join(output, 'context.json'), 'utf8')), { schemaVersion: 1, host: 'https://custom.example', space: 'applications' });
  assert.ok(prompt.includes('http://127.0.0.1:6199/agents/setup.md'));
  const md = await readFile(join(output, 'setup.md'), 'utf8');
  assert.ok(md.includes('http://127.0.0.1:6199/agents/tinychat-retrieval/'));
  assert.ok(!md.includes('https://tinycloud.chat/agents/tinychat-retrieval/'));
});

test('deployment environment config wins over the standard hosted default', async t => {
  const { output, result } = await build(t, [], { VITE_TINYCLOUD_HOST: 'https://deployment.example' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(pageContext(await readFile(join(output, 'setup.md'), 'utf8')).host, 'https://deployment.example');
});

test('explicit data host wins over build environment', async t => {
  const { output, result } = await build(t, ['--host', 'https://override.example'], { VITE_TINYCLOUD_HOST: 'https://deployment.example' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(pageContext(await readFile(join(output, 'setup.md'), 'utf8')).host, 'https://override.example');
});

test('invalid explicitly configured data host fails generation instead of falling back', async t => {
  const { result } = await build(t, [], { VITE_TINYCLOUD_HOST: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /setup configuration/i);
});

test('mutable setup routes revalidate and versioned artifacts remain immutable', async () => {
  const headers = await readFile(new URL('frontend/public/_headers', root), 'utf8');
  const rules = Object.fromEntries(headers.trim().split(/\n(?=\/)/).map(block => {
    const [route, ...values] = block.split('\n');
    return [route, values.join('\n')];
  }));
  for (const route of ['/agents/', '/agents/index.html', '/agents/setup.md', '/agents/prompt.txt', '/agents/context.json']) {
    assert.match(rules[route] ?? '', /Cache-Control: no-cache/, route);
  }
  assert.match(rules['/agents/context.json'], /Content-Type: application\/json/);
  assert.match(rules['/agents/tinychat-retrieval/*'], /max-age=31536000, immutable/);
});
