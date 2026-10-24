// Real native Vector, the real compiled boundary and the real cap transform; no sockets. GELF packets go in on stdin (the
// only source substitution) and every sink input is printed by a console sink. The cap timer is wall-clock, so the check
// lasts about three cap windows (about 3 minutes): per-key caps in the first two, the whole-stream cap in the third.
// Usage: node log-shipper/cap-check.mjs VECTOR_BINARY
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from './build.mjs';
import { CAP_PER_WINDOW, CAP_WINDOW_SECONDS } from './limits.mjs';
import { packet } from './cases.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));

export async function checkCaps(vector, tmpRoot = process.env.TMPDIR) {
  if (!tmpRoot || !tmpRoot.startsWith('/var/tmp/')) throw new Error('TMPDIR must be a mktemp -d -p /var/tmp directory');
  const dir = await mkdtemp(join(tmpRoot, 'tc1978-cap-'));
  let child;
  let closed;
  try {
    const streamCap = 100;
    const config = buildConfig({ token: 'tc1978-synthetic-only', dataDir: dir, limits: { maxLines: streamCap } });
    config.sources = { gelf_in: { type: 'stdin', framing: { method: 'newline_delimited' }, decoding: { codec: 'bytes' } } };
    config.sinks = { out: { type: 'console', inputs: [...config.sinks.betterstack.inputs], target: 'stdout', encoding: { codec: 'json' } } };
    const path = join(dir, 'vector.json');
    await writeFile(path, JSON.stringify(config));
    const events = [];
    let pending = '';
    child = spawn(vector, ['--config', path], { env: { HOME: dir }, stdio: ['pipe', 'pipe', 'ignore'] });
    closed = once(child, 'close');
    child.stdout.on('data', chunk => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines.filter(Boolean)) events.push(JSON.parse(line));
    });
    const send = lines => new Promise((done, fail) => child.stdin.write(lines.map(line => `${line}\n`).join(''), error => error ? fail(error) : done()));
    const waitFor = async (predicate, seconds, what) => {
      for (let attempt = 0; attempt < seconds * 10; attempt++) { if (predicate()) return; await sleep(100); }
      assert.fail(`timed out waiting for ${what}`);
    };
    const drops = () => events.filter(event => event.event === 'log_dropped');
    const chat = n => packet(`[transcript-delivery] op=deliver result=written pad=${n}`);
    const other = n => packet(`[calendar-autojoin] code=tick_done ms=${n}`);
    const passed = (component, key, value) => events.filter(event => event.event === 'backend_log' && event.component === component && event[key] === value);

    // Window 1: one key overflows by 15, another stays under the cap, a third sits exactly at it.
    await send([...Array.from({ length: CAP_PER_WINDOW + 15 }, (_, index) => chat(index)), ...Array.from({ length: 5 }, (_, index) => other(index)), ...Array.from({ length: CAP_PER_WINDOW }, () => packet('[chat] stream error: boom', { level: 3 }))]);
    await waitFor(() => drops().length >= 1, CAP_WINDOW_SECONDS + 30, 'the first dropped-count event');
    await sleep(2000);
    assert.equal(drops().length, 1, 'only the overflowing key reports');
    assert.deepEqual({ ...drops()[0], ts: undefined }, { ts: undefined, level: 'warn', event: 'log_dropped', svc: 'backend', component: 'transcript-delivery', event_code: 'structured', op: 'deliver', result: 'written', dropped: 15, window_s: CAP_WINDOW_SECONDS });
    assert.match(drops()[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(passed('transcript-delivery', 'op', 'deliver').length, CAP_PER_WINDOW, 'the first cap events of the overflowing key ship');
    assert.equal(passed('calendar-autojoin', 'code', 'tick_done').length, 5, 'a key under its cap ships everything');
    assert.equal(events.filter(event => event.event_code === 'chat_stream_error').length, CAP_PER_WINDOW, 'a key exactly at its cap ships everything');

    // Window 2: counters reset, so the same key ships its full cap again and reports its new overflow.
    const shippedBefore = passed('transcript-delivery', 'op', 'deliver').length;
    await send(Array.from({ length: 500 }, (_, index) => chat(1000 + index)));
    await waitFor(() => drops().length >= 2, CAP_WINDOW_SECONDS + 30, 'the second dropped-count event');
    assert.equal(passed('transcript-delivery', 'op', 'deliver').length - shippedBefore, CAP_PER_WINDOW);
    assert.equal(drops()[1].dropped, 500 - CAP_PER_WINDOW);
    assert.ok(!JSON.stringify(events).includes('pad='), 'no raw line content reaches the sink');

    // Window 3: five keys at exactly their own cap (150 lines) exceed the whole-stream cap of 100: 100 pass in arrival order,
    // the other 50 are counted in ONE fixed `log_stream_dropped` event, and no per-key overflow is reported.
    const components = ['connector-ingest', 'connector-queue', 'connector-drain', 'connector-fetch', 'connector-content'];
    const streamLines = components.flatMap(component => Array.from({ length: CAP_PER_WINDOW }, (_, index) => packet(`[${component}] op=probe result=ok n=${index}`)));
    const dropsBefore = drops().length;
    await send(streamLines);
    const streamDrops = () => events.filter(event => event.event === 'log_stream_dropped');
    await waitFor(() => streamDrops().length >= 1, CAP_WINDOW_SECONDS + 30, 'the whole-stream dropped-count event');
    await sleep(2000);
    assert.equal(streamDrops().length, 1, 'exactly one whole-stream dropped-count event per window');
    assert.deepEqual({ ...streamDrops()[0], ts: undefined }, { ts: undefined, level: 'warn', event: 'log_stream_dropped', svc: 'backend', dropped: streamLines.length - streamCap, window_s: CAP_WINDOW_SECONDS });
    assert.equal(events.filter(event => event.op === 'probe').length, streamCap, 'exactly the whole-stream cap ships');
    assert.equal(drops().length, dropsBefore, 'no per-key overflow in the whole-stream window');
    const firstProbe = events.filter(event => event.op === 'probe').map(event => event.component);
    assert.deepEqual(firstProbe, components.flatMap(component => Array(CAP_PER_WINDOW).fill(component)).slice(0, streamCap), 'the first lines in arrival order pass');
    return { status: 'passed', window_s: CAP_WINDOW_SECONDS, cap: CAP_PER_WINDOW, stream_cap: streamCap, dropped_events: drops().length, stream_dropped_events: streamDrops().length };
  } finally {
    if (child) { child.stdin.end(); child.kill('SIGTERM'); await closed; }
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: cap-check.mjs VECTOR_BINARY');
  checkCaps(resolve(process.argv[2])).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.log(JSON.stringify({ status: 'failed', reason: String(error?.message ?? error).slice(0, 300) }));
    process.exitCode = 1;
  });
}
