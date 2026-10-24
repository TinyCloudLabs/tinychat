// Real native Vector, the real compiled boundary and the real cap transform; no sockets. GELF packets go in on stdin (the
// only source substitution) and every sink input is printed by a console sink. The cap timer is wall-clock, so the check
// lasts about four cap windows (about 4 minutes): per-key caps in the first two, the whole-stream cap in the third, and the ceiling on
// ALL lines reaching the sink (including the dropped-count lines) under 150 flooded keys in the fourth.
// Usage: node log-shipper/cap-check.mjs VECTOR_BINARY
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from './build.mjs';
import { CAP_PER_WINDOW, CAP_WINDOW_SECONDS, MAX_DROPPED_LINES, lineCeiling } from './limits.mjs';
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

    // Window 4: 150 keys x 40 lines. Every key overflows its own cap, so there are 150 per-key overflows, but the sink gets at
    // most MAX_DROPPED_LINES per-key lines: the rest are folded into the one stream line. The whole-stream cap is a true
    // ceiling: passed lines + per-key lines + the stream line never exceed streamCap + MAX_DROPPED_LINES + 1.
    const keysFlooded = 150;
    const perKey = 40;
    const flood = Array.from({ length: keysFlooded }, (_, key) => Array.from({ length: perKey }, (_, index) => packet(`[chat] op=k${key} result=ok n=${index}`))).flat();
    await send(flood);
    await waitFor(() => streamDrops().length >= 2, CAP_WINDOW_SECONDS + 30, 'the stream dropped-count event of the flood window');
    await sleep(2000);
    const floodPassed = events.filter(event => event.event === 'backend_log' && /^k\d+$/.test(event.op ?? ''));
    const floodKeyLines = events.filter(event => event.event === 'log_dropped' && /^k\d+$/.test(event.op ?? ''));
    const floodStream = streamDrops()[1];
    assert.equal(floodPassed.length, streamCap, 'exactly the whole-stream cap passes');
    assert.equal(floodKeyLines.length, MAX_DROPPED_LINES, 'at most MAX_DROPPED_LINES per-key lines are emitted');
    assert.equal(new Set(floodKeyLines.map(event => event.op)).size, MAX_DROPPED_LINES);
    assert.ok(floodKeyLines.every(event => event.dropped === perKey - CAP_PER_WINDOW && event.component === 'chat' && event.result === 'ok'));
    const streamOverflow = keysFlooded * CAP_PER_WINDOW - streamCap;
    const folded = (keysFlooded - MAX_DROPPED_LINES) * (perKey - CAP_PER_WINDOW);
    assert.equal(floodStream.dropped, streamOverflow + folded, 'the stream line carries the stream overflow plus the folded per-key drops');
    assert.equal(streamDrops().length, 2);
    const linesAtSink = floodPassed.length + floodKeyLines.length + 1;
    assert.ok(linesAtSink <= streamCap + MAX_DROPPED_LINES + 1 && linesAtSink <= lineCeiling(streamCap), `lines at the sink in the flood window: ${linesAtSink}`);
    return { status: 'passed', window_s: CAP_WINDOW_SECONDS, cap: CAP_PER_WINDOW, stream_cap: streamCap, flood_lines_at_sink: linesAtSink, line_ceiling: lineCeiling(streamCap), dropped_events: drops().length, stream_dropped_events: streamDrops().length };
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
