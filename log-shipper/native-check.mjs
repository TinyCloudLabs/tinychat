// Real native Vector with the real compiled boundary: UDP in (the Docker gelf driver's wire form), the local console
// sink and the HTTP sink out to a local capture server. Synthetic inputs only; the sink URI and token are local
// stand-ins, never the production sink. Two runs, as the sidecar does it:
//   local-only: the base config alone (token absent): the filtered stream must still be printed locally, nothing is sent.
//   shipping:   base + ship config: the HTTP sink and the local sink carry the same filtered events.
// Usage: node log-shipper/native-check.mjs VECTOR_BINARY  (about 90 s)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildParts } from './build.mjs';
import { canary, packet } from './cases.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const canon = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
const ordered = list => list.map(value => JSON.parse(canon(value))).sort((a, b) => canon(a).localeCompare(canon(b)));
const withoutTs = ({ ts, ...rest }) => rest;
const expected = ordered([
  { event: 'backend_log', svc: 'backend', level: 'error', component: 'process', event_code: 'error_line', error_class: 'TypeError' },
  { event: 'backend_log', svc: 'backend', level: 'info', component: 'transcript-delivery', event_code: 'structured', op: 'deliver', result: 'written' },
  { event: 'backend_log', svc: 'backend', level: 'warn', component: 'transcript-delivery', event_code: 'structured', op: 'deliver', result: 'error', code: 'delivery_error' },
]);

/** One Vector run. `ship` adds the HTTP sink; returns what the capture server and the console saw. */
async function session(vector, tmpRoot, { ship }) {
  const dir = await mkdtemp(join(tmpRoot, 'tc1978-native-'));
  const http = [];
  const local = [];
  const authorizations = new Set();
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    authorizations.add(request.headers.authorization);
    let body = Buffer.concat(chunks);
    if (request.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
    for (const line of body.toString().split('\n').filter(Boolean)) http.push(JSON.parse(line));
    response.writeHead(200).end();
  });
  const udp = createSocket('udp4');
  let child;
  let closed;
  let consoleText = '';
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    await new Promise(done => udp.bind(0, '127.0.0.1', done));
    const port = udp.address().port;
    await new Promise(done => udp.close(done));
    const parts = buildParts({ sourceAddress: `127.0.0.1:${port}`, uri: `http://127.0.0.1:${server.address().port}/`, token: 'tc1978-synthetic-only', dataDir: dir });
    const files = [join(dir, 'runtime.json')];
    await writeFile(files[0], JSON.stringify(parts.base));
    if (ship) { files.push(join(dir, 'ship.json')); await writeFile(files[1], JSON.stringify(parts.ship)); }
    child = spawn(vector, files.flatMap(file => ['--config', file]), { env: { HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    closed = once(child, 'close');
    let pending = '';
    child.stdout.on('data', chunk => {
      consoleText += chunk.toString();
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) if (line.startsWith('{"')) { try { local.push(JSON.parse(line)); } catch { /* a partial vector log line */ } }
    });
    child.stderr.on('data', chunk => { consoleText += chunk.toString(); });
    const sender = createSocket('udp4');
    const send = line => new Promise((done, fail) => { sender.send(Buffer.from(line), port, '127.0.0.1', error => error ? fail(error) : done()); });
    // Vector binds the socket a moment after start; resend a readiness line until it is seen.
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      await send(packet('[calendar-autojoin] code=share_granted'));
      await sleep(200);
      ready = local.some(event => event.code === 'share_granted') && (!ship || http.some(event => event.code === 'share_granted'));
    }
    assert.ok(ready, 'vector never delivered the readiness event');
    await sleep(2000);
    const beforeLocal = local.length;
    const beforeHttp = http.length;
    await send(packet(`[transcript-delivery] op=deliver result=written id=${canary}`));
    await send(packet(`[transcript-delivery] op=deliver result=error id=${canary} code=delivery_error`, { level: 3 }));
    await send(packet(`TypeError: ${canary} 0xAbCdEf0123456789abcdef0123456789abCDef01`, { level: 3 }));
    await send(packet(`free text ${canary} person@example.test`));
    await send(packet('[calendar-autojoin] code=share_granted', { label: 'tinycloud-node' }));
    await send('not json');
    await send(packet(`[transcript-delivery] op=deliver result=written ${'x'.repeat(5000)}`));
    const shipped = events => events.slice(0).filter(event => event.event === 'backend_log' && event.code !== 'share_granted');
    for (let attempt = 0; attempt < 100 && (shipped(local.slice(beforeLocal)).length < 3 || (ship && shipped(http.slice(beforeHttp)).length < 3)); attempt++) await sleep(100);
    // The gate summary is reduced per minute (and may split across two windows): wait for all four counts on every sink.
    const gateCounts = events => { const counts = {}; for (const event of events.filter(event => event.event === 'logship_gate_summary_total')) counts[event.gate_reason] = (counts[event.gate_reason] ?? 0) + event.count; return counts; };
    const total = events => Object.values(gateCounts(events)).reduce((sum, count) => sum + count, 0);
    for (let attempt = 0; attempt < 1300 && (total(local) < 4 || (ship && total(http) < 4)); attempt++) await sleep(100);
    sender.close();

    assert.deepEqual(ordered(shipped(local.slice(beforeLocal)).map(withoutTs)), expected, 'the local sink prints the filtered events');
    assert.deepEqual(gateCounts(local), { unclassified_info: 1, unexpected_label: 1, malformed_envelope: 1, oversized: 1 });
    assert.ok(!consoleText.includes(canary), 'no synthetic secret may reach the Vector console, which Docker keeps');
    assert.ok(!/person@example|0xAbCdEf/.test(consoleText), 'no raw content may reach the Vector console');
    if (ship) {
      assert.deepEqual(ordered(shipped(http.slice(beforeHttp)).map(withoutTs)), expected, 'the HTTP sink ships the filtered events');
      assert.deepEqual(gateCounts(http), gateCounts(local), 'both sinks carry the same gate counts');
      assert.ok(!JSON.stringify(http).includes(canary), 'no synthetic secret may reach the sink');
      assert.deepEqual([...authorizations], ['Bearer tc1978-synthetic-only']);
    } else {
      assert.equal(requests, 0, 'without the ship config nothing is sent');
    }
    return { shipped: shipped(local.slice(beforeLocal)).length, gate_counts: gateCounts(local) };
  } finally {
    if (child) { child.kill('SIGTERM'); await closed; }
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

export async function checkNativeVector(vector, tmpRoot = process.env.TMPDIR) {
  if (!tmpRoot || !tmpRoot.startsWith('/var/tmp/')) throw new Error('TMPDIR must be a mktemp -d -p /var/tmp directory');
  const localOnly = await session(vector, tmpRoot, { ship: false });
  const shipping = await session(vector, tmpRoot, { ship: true });
  return { status: 'passed', local_only: localOnly, shipping };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: native-check.mjs VECTOR_BINARY');
  checkNativeVector(resolve(process.argv[2])).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.log(JSON.stringify({ status: 'failed', reason: String(error?.message ?? error).slice(0, 300) }));
    process.exitCode = 1;
  });
}
