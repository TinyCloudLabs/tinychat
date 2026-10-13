#!/usr/bin/env node
import { createConsumer } from '../lib/consumer.mjs';
import { createSetup } from '../lib/setup.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const help = `TinyChat compact evidence consumer
node scripts/consume.mjs COMMAND --operation HANDLE --session SESSION [OPTIONS]
latest: --source NAME, --from ISO, --to ISO, --retry (select, acquire once and return evidence)
next: --chunk N (copy nextAction; repeating a chunk returns identical evidence)
discover: --page N (default 1), --term TEXT, --source NAME, --from ISO, --to ISO, --limit 1..10
read: --meeting N (first selection after discover), --retry (return evidence or retry failed acquisition)
status: optional acquisition and delivery diagnostics
restart: --new-operation HANDLE (fresh acquisition and first evidence for the same selected meeting)
Optional --root ABS_PRIVATE_DIRECTORY must be outside the project. Setup comes from the normal TinyChat setup state.
Run actions sequentially. Follow nextAction only when non-null; the final evidence needs no additional call.
Cite the delivered spans' ref values directly and check meaning and speaker against their exact text.
A complete returned payload is not proof of model delivery: portable CLI stdout has no client delivery hook.
Continuation uses hash-verified historical evidence; it does not verify current remote authority or revision. Restart reacquires.
No reference/cursor arguments are accepted. --retry retries a failed acquisition, never downloads successful evidence again.
`;

try {
  const numeric = new Set(['meeting', 'page', 'limit', 'chunk']);
  const strings = ['operation', 'session', 'root', 'meeting', 'page', 'chunk', 'new-operation', 'term', 'source', 'from', 'to', 'limit'];
  const { values, positionals, tokens } = parseArgs({ allowPositionals: true, tokens: true, options: { ...Object.fromEntries(strings.map(name => [name, { type: 'string' }])), retry: { type: 'boolean' }, help: { type: 'boolean' } } });
  const names = tokens.filter(token => token.kind === 'option').map(token => token.name);
  if (new Set(names).size !== names.length) throw new Error('INVALID_INPUT');
  if (values.help) process.stdout.write(help);
  else {
    if (!process.env.HOME || positionals.length !== 1 || !values.session) throw new Error('INVALID_INPUT');
    const input = {};
    for (const [key, value] of Object.entries(values)) {
      if (['session', 'root'].includes(key)) continue;
      input[key === 'new-operation' ? 'newOperation' : key] = numeric.has(key) ? /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN : value;
    }
    const setup = createSetup({ statePath: join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'tinychat-retrieval/setup.json'), manifestPath: fileURLToPath(new URL('../assets/permissions.json', import.meta.url)) });
    const result = await createConsumer({ setup, ...(values.root ? { root: values.root } : {}) }).invoke(positionals[0], input, { sessionID: values.session });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = result.exitCode || 1;
  }
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'INVALID_INPUT', message: 'Use --help for supported short handles and saved-state commands. No reference or cursor arguments are accepted.' }, exitCode: 1 }) + '\n');
  process.exitCode = 1;
}
