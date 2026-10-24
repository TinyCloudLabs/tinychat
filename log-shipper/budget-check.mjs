// Real native Vector, the real compiled boundary and the real daily budget; no sockets. GELF packets go in on stdin and the
// two sinks are files: `shipped` is what would go to the log service, `local` is the local copy. The "day" is shortened to
// DAY seconds (epoch-aligned, like the real UTC day) and the budget to a few hundred bytes so the check takes about 40 s.
// It proves: the budget stops shipping and the local copy continues; exactly one fixed line is added, locally only; nothing
// is shipped for the rest of the day; and at the next day boundary the counter resets.
// Usage: node log-shipper/budget-check.mjs VECTOR_BINARY
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from './build.mjs';
import { estimateBytes } from './limits.mjs';
import { packet } from './cases.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const DAY = 20;

export async function checkBudget(vector, tmpRoot = process.env.TMPDIR) {
  if (!tmpRoot || !tmpRoot.startsWith('/var/tmp/')) throw new Error('TMPDIR must be a mktemp -d -p /var/tmp directory');
  const dir = await mkdtemp(join(tmpRoot, 'tc1978-budget-'));
  let child;
  let closed;
  try {
    // The lines below become `{ts, level, event, svc, component, event_code: "structured", code: "probe"}` after the sanitizer;
    // the budget is the estimated size of the first `fits` of them plus a few spare bytes, too few for another event.
    const tags = ['agent', 'auth', 'billing', 'chat', 'credits', 'exo', 'relay', 'startup', 'transcriber', 'delegations'];
    const sizeOf = index => estimateBytes({ ts: '2026-10-24T00:00:00.000Z', level: 'info', event: 'backend_log', svc: 'backend', component: tags[index % tags.length], event_code: 'structured', code: 'probe' });
    const fits = 4;
    const budget = Array.from({ length: fits }, (_, index) => sizeOf(index)).reduce((sum, size) => sum + size, 0) + 10;
    const config = buildConfig({ token: 'tc1978-synthetic-only', dataDir: dir, limits: { dailyBudget: budget, daySeconds: DAY, maxLines: 100000 } });
    config.sources = { gelf_in: { type: 'stdin', framing: { method: 'newline_delimited' }, decoding: { codec: 'bytes' } } };
    config.sinks = {
      shipped: { type: 'file', inputs: [...config.sinks.betterstack.inputs], path: join(dir, 'shipped.ndjson'), encoding: { codec: 'json' } },
      local: { type: 'file', inputs: [...config.sinks.local.inputs], path: join(dir, 'local.ndjson'), encoding: { codec: 'json' } },
    };
    const path = join(dir, 'vector.json');
    await writeFile(path, JSON.stringify(config));
    child = spawn(vector, ['--config', path], { env: { HOME: dir }, stdio: ['pipe', 'ignore', 'ignore'] });
    closed = once(child, 'close');
    const send = lines => new Promise((done, fail) => child.stdin.write(lines.map(line => `${line}\n`).join(''), error => error ? fail(error) : done()));
    const read = async name => (await readFile(join(dir, name), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const settle = async (name, count, what) => {
      for (let attempt = 0; attempt < 300; attempt++) { if ((await read(name)).length >= count) { await sleep(500); return; } await sleep(100); }
      assert.fail(`timed out waiting for ${what}`);
    };
    // Distinct components, so neither the per-key cap nor the stream cap interferes.
    const line = index => packet(`[${tags[index % tags.length]}] code=probe`);
    const day = () => Math.floor(Date.now() / 1000 / DAY);

    // Start just after a day boundary so the first part of the check sits inside one day.
    while ((Date.now() / 1000) % DAY > 2) await sleep(100);
    await sleep(500);
    const firstDay = day();
    const events = fits;
    await send(Array.from({ length: events + 6 }, (_, index) => line(index)));
    await settle('local.ndjson', events + 6 + 1, 'the local copy of the first day');
    const shipped1 = await read('shipped.ndjson');
    const local1 = await read('local.ndjson');
    assert.equal(day(), firstDay, 'the first-day part must finish inside its day');
    assert.equal(shipped1.length, fits, 'the budget lets exactly the events that fit through');
    assert.ok(shipped1.every(event => event.event === 'backend_log' && !('_ship' in event)));
    assert.equal(local1.length, events + 6 + 1, 'the local copy has every event plus one fixed line');
    assert.ok(local1.every(event => !('_ship' in event)));
    const notices = local1.filter(event => event.event === 'daily_budget_reached');
    assert.equal(notices.length, 1, 'exactly one fixed line');
    assert.deepEqual({ ...notices[0], ts: undefined }, { ts: undefined, level: 'warn', event: 'daily_budget_reached', svc: 'logship', budget_bytes: budget });
    assert.equal(shipped1.filter(event => event.event === 'daily_budget_reached').length, 0, 'the fixed line is local only');

    // Same day, more lines: nothing more is shipped, no second fixed line, the local copy keeps going.
    await send(Array.from({ length: 5 }, (_, index) => line(index)));
    await settle('local.ndjson', events + 6 + 1 + 5, 'more local lines on the same day');
    assert.equal(day(), firstDay, 'the same-day part must finish inside its day');
    assert.equal((await read('shipped.ndjson')).length, fits, 'nothing more ships for the rest of the day');
    assert.equal((await read('local.ndjson')).filter(event => event.event === 'daily_budget_reached').length, 1);

    // Next day: the counter resets, shipping resumes, and the budget applies again with a new fixed line.
    while (day() === firstDay) await sleep(200);
    await sleep(500);
    await send(Array.from({ length: events + 2 }, (_, index) => line(index)));
    await settle('local.ndjson', events + 6 + 1 + 5 + events + 2 + 1, 'the local copy of the second day');
    assert.equal((await read('shipped.ndjson')).length, fits * 2, 'shipping resumed after the reset and stopped at the budget again');
    assert.equal((await read('local.ndjson')).filter(event => event.event === 'daily_budget_reached').length, 2);
    return { status: 'passed', budget_bytes: budget, shipped_per_day: fits, day_s: DAY };
  } finally {
    if (child) { child.stdin.end(); child.kill('SIGTERM'); await closed; }
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: budget-check.mjs VECTOR_BINARY');
  checkBudget(resolve(process.argv[2])).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.log(JSON.stringify({ status: 'failed', reason: String(error?.message ?? error).slice(0, 300) }));
    process.exitCode = 1;
  });
}
