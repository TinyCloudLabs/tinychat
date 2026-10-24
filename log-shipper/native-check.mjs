// Real native Vector with the real compiled boundary: UDP in (the Docker gelf driver's wire form), HTTP out to a local
// capture server. Synthetic inputs only; the sink URI and token are local stand-ins, never the production sink.
// Usage: node log-shipper/native-check.mjs VECTOR_BINARY  (about 15 s)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildConfig } from './build.mjs';
import { canary, packet } from './cases.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));

export async function checkNativeVector(vector, tmpRoot = process.env.TMPDIR) {
  if (!tmpRoot || !tmpRoot.startsWith('/var/tmp/')) throw new Error('TMPDIR must be a mktemp -d -p /var/tmp directory');
  const dir = await mkdtemp(join(tmpRoot, 'tc1978-native-'));
  const events = [];
  const authorizations = new Set();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    authorizations.add(request.headers.authorization);
    let body = Buffer.concat(chunks);
    if (request.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
    for (const line of body.toString().split('\n').filter(Boolean)) events.push(JSON.parse(line));
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
    const config = buildConfig({ sourceAddress: `127.0.0.1:${port}`, uri: `http://127.0.0.1:${server.address().port}/`, token: 'tc1978-synthetic-only', dataDir: dir });
    const path = join(dir, 'vector.json');
    await writeFile(path, JSON.stringify(config));
    child = spawn(vector, ['--config', path], { env: { HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    closed = once(child, 'close');
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { consoleText += chunk.toString(); });
    const sender = createSocket('udp4');
    const send = line => new Promise((done, fail) => { const data = Buffer.from(line); sender.send(data, port, '127.0.0.1', error => error ? fail(error) : done()); });
    // Vector binds the socket a moment after start; resend a readiness line until it is seen.
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      await send(packet('[calendar-autojoin] code=share_granted'));
      await sleep(200);
      ready = events.some(event => event.code === 'share_granted');
    }
    assert.ok(ready, 'vector never delivered the readiness event');
    await sleep(2000);
    const before = events.length;
    await send(packet(`[transcript-delivery] op=deliver result=written id=${canary}`));
    await send(packet(`[transcript-delivery] op=deliver result=error id=${canary} code=delivery_error`, { level: 3 }));
    await send(packet(`TypeError: ${canary} 0xAbCdEf0123456789abcdef0123456789abCDef01`, { level: 3 }));
    await send(packet(`free text ${canary} person@example.test`));
    await send(packet('[calendar-autojoin] code=share_granted', { label: 'tinycloud-node' }));
    await send('not json');
    await send(packet(`[transcript-delivery] op=deliver result=written ${'x'.repeat(5000)}`));
    for (let attempt = 0; attempt < 100 && events.length < before + 3; attempt++) await sleep(100);
    // The gate summary is reduced per minute (and may split across two windows): wait for all four counts.
    const gateTotal = () => events.filter(event => event.event === 'logship_gate_summary_total').reduce((sum, event) => sum + event.count, 0);
    for (let attempt = 0; attempt < 1300 && gateTotal() < 4; attempt++) await sleep(100);
    sender.close();

    const shipped = events.slice(before).filter(event => event.event === 'backend_log' && event.code !== 'share_granted');
    const canon = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
    const ordered = list => list.map(value => JSON.parse(canon(value))).sort((a, b) => canon(a).localeCompare(canon(b)));
    assert.deepEqual(ordered(shipped.map(({ ts, ...rest }) => rest)), ordered([
      { event: 'backend_log', svc: 'backend', level: 'error', component: 'process', event_code: 'error_line', error_class: 'TypeError' },
      { event: 'backend_log', svc: 'backend', level: 'info', component: 'transcript-delivery', event_code: 'structured', op: 'deliver', result: 'written' },
      { event: 'backend_log', svc: 'backend', level: 'warn', component: 'transcript-delivery', event_code: 'structured', op: 'deliver', result: 'error', code: 'delivery_error' },
    ]));
    const counts = {};
    for (const event of events.filter(event => event.event === 'logship_gate_summary_total')) counts[event.gate_reason] = (counts[event.gate_reason] ?? 0) + event.count;
    assert.deepEqual(counts, { unclassified_info: 1, unexpected_label: 1, malformed_envelope: 1, oversized: 1 });
    assert.ok(!JSON.stringify(events).includes(canary), 'no synthetic secret may reach the sink');
    assert.ok(!consoleText.includes(canary), 'no synthetic secret may reach the Vector console');
    assert.deepEqual([...authorizations], ['Bearer tc1978-synthetic-only']);
    return { status: 'passed', shipped: shipped.length, gate_counts: counts };
  } finally {
    if (child) { child.kill('SIGTERM'); await closed; }
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: native-check.mjs VECTOR_BINARY');
  checkNativeVector(resolve(process.argv[2])).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.log(JSON.stringify({ status: 'failed', reason: String(error?.message ?? error).slice(0, 300) }));
    process.exitCode = 1;
  });
}
