// Synthetic inputs only. Native Vector evaluates every assertion after the full boundary (envelope, gate, allowlist,
// guard). A case is either "ships exactly this object" or "ships nothing and is counted under this gate reason".
import { CAP_PER_WINDOW, MAX_LINE_BYTES, estimateBytes } from './limits.mjs';
import { readFileSync } from 'node:fs';

export const canary = 'TC1978_SYNTHETIC';
const address = '0xAbCdEf0123456789abcdef0123456789abCDef01';
const hex40 = 'a3f4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2';
const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2ln';
const did = 'did:pkh:eip155:1:0xAbCdEf0123456789abcdef0123456789abCDef01';
const email = 'person@example.test';
const uuid = '8a0f8a1e-3c7b-4f0e-9c1d-0a1b2c3d4e5f';

/** A GELF 1.1 packet as the Docker gelf driver sends it: one console line in short_message, level 3 for stderr. */
export const packet = (line, { level = 6, label = 'tinychat-backend', extra = {} } = {}) => JSON.stringify({
  version: '1.1', host: `host-${canary}`, short_message: line, timestamp: 1790000000.123, level,
  container_id: `cid-${canary}`, container_name: `name-${canary}`, ...(label === false ? {} : { '_tc.logship': label }), ...extra,
});
const vrl = value => JSON.stringify(value);
/** A valid line of exactly MAX_LINE_BYTES bytes: unknown keys with short values pad it out. */
function atLimit() {
  let line = '[transcript-delivery] op=deliver result=written';
  for (let index = 0; line.length + 1 + 'pad0000=xxxxxxxxxxxxxxxxxxxx'.length + 4 <= MAX_LINE_BYTES; index++) line += ` pad${String(index).padStart(4, '0')}=xxxxxxxxxxxxxxxxxxxx`;
  line += ` p=${'y'.repeat(MAX_LINE_BYTES - line.length - 3)}`;
  if (line.length !== MAX_LINE_BYTES) throw new Error(`atLimit built ${line.length} bytes`);
  return line;
}
const input = (message, insertAt = 'gelf_envelope') => ({ insert_at: insertAt, type: 'log', log_fields: { message } });
// Nothing from the envelope or the raw line may reach the output, whatever else the case asserts.
const clean = `assert!(!contains(encode_json(.), "${canary}"))\nassert!(!exists(.line) && !exists(.message) && !exists(.host) && !exists(.short_message) && !exists(.container_id))`;

/** Ships exactly `expected` (plus a well-formed ts). */
const ships = (name, line, expected, options) => ({
  name,
  inputs: [input(packet(line, options))],
  outputs: [{ extract_from: 'guard', conditions: [{ type: 'vrl', source: `assert!(match(string!(.ts), r'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'))\nassert_eq!(., merge(${vrl(expected)}, {"ts": .ts}))\n${clean}` }] }],
  no_outputs_from: ['gate_counts'],
});
/** Ships nothing; the gate counts it as `reason` (content-free: only the reason and a count of one). */
const drops = (name, message, reason) => ({
  name,
  inputs: [input(message)],
  no_outputs_from: ['guard'],
  outputs: [{ extract_from: 'gate_counts', conditions: [{ type: 'vrl', source: `assert_eq!(., {"gate_reason": ${vrl(reason)}, "count": 1})` }] }],
});
const droppedLine = (name, line, reason = 'unclassified_info', options) => drops(name, packet(line, options), reason);
const base = { event: 'backend_log', svc: 'backend' };
const structured = (component, attrs, level = 'info') => ({ ...base, level, component, event_code: 'structured', ...attrs });
const registered = (component, event_code, level) => ({ ...base, level, component, event_code });

export const vectorTests = [
  // --- the lines the team needs readable --------------------------------------------------------------------------------
  ships('transcript delivery: written ships op and result; the id is dropped', `[transcript-delivery] op=deliver result=written id=trn_01HZZZZZZZZZZZZZZZZZZZZZZZ`, structured('transcript-delivery', { op: 'deliver', result: 'written' })),
  ships('transcript delivery: an error on stderr ships as warn with its fixed code; the id is dropped', `[transcript-delivery] op=deliver result=error id=trn_01HZZZZZZZZZZZZZZZZZZZZZZZ code=delivery_error`, structured('transcript-delivery', { op: 'deliver', result: 'error', code: 'delivery_error' }, 'warn'), { level: 3 }),
  ships('transcript delivery: schema_missing', `[transcript-delivery] op=deliver result=schema_missing id=abc`, structured('transcript-delivery', { op: 'deliver', result: 'schema_missing' })),
  ships('transcript delivery: sweep result without an id', '[transcript-delivery] op=sweep result=unreadable_address', structured('transcript-delivery', { op: 'sweep', result: 'unreadable_address' }, 'warn'), { level: 3 }),
  ships('calendar autojoin: share_granted', '[calendar-autojoin] code=share_granted', structured('calendar-autojoin', { code: 'share_granted' })),
  ships('calendar autojoin: share_denied with its reason', '[calendar-autojoin] code=share_denied reason=not_accepted', structured('calendar-autojoin', { code: 'share_denied', reason: 'not_accepted' })),
  ships('calendar autojoin: tick counts are integers', '[calendar-autojoin] code=tick_done ms=12 tenants=3 rows=40 scans=7 timers=2', structured('calendar-autojoin', { code: 'tick_done', ms: 12, tenants: 3, rows: 40, scans: 7, timers: 2 })),
  ships('credential row count: source and count', 'credential_row_count source=fireflies count=12', { ...base, level: 'info', component: 'credential-row-count', event_code: 'structured', source: 'fireflies', count: 12 }),
  ships('credential row count: unavailable ships a flag and the fixed code, never a number', 'credential_row_count source=google count=unavailable code=list_failed', { ...base, level: 'info', component: 'credential-row-count', event_code: 'structured', source: 'google', count_unavailable: true, code: 'list_failed' }),
  ships('budget preflight: the header line is a registered fixed event', '[agent-chat] turn budget {', registered('agent-chat', 'agent_chat_turn_budget', 'info')),
  ships('budget preflight: the event field line ships as a fixed value', '  event: "preflight",', { ...base, level: 'info', component: 'object', event_code: 'object_field', budget_event: 'preflight' }),
  ships('budget preflight: the mode field line ships as a fixed value', '  mode: "enforce",', { ...base, level: 'info', component: 'object', event_code: 'object_field', budget_mode: 'enforce' }),
  ships('route error status field ships as an HTTP status', '  status: 500,', { ...base, level: 'info', component: 'object', event_code: 'object_field', status: 500 }),
  droppedLine('object fields outside the declared set are dropped (credit amounts, execution ids)', '  remaining: 3,'),
  droppedLine('object field with free text is dropped', `  executionId: "${uuid}",`),
  droppedLine('object field status outside 1xx-5xx is dropped', '  status: 999,'),
  ships('uncaught error: only the error class ships, not the message', `TypeError: boom for ${address} at https://example.test/a?token=${jwt}`, { ...base, level: 'error', component: 'process', event_code: 'error_line', error_class: 'TypeError' }, { level: 3 }),
  ships('uncaught error: an unknown class ships as other', `CustomThingError: ${email}`, { ...base, level: 'error', component: 'process', event_code: 'error_line', error_class: 'other' }, { level: 3 }),
  ships('registered fixed message ships as its code; the error text after it is dropped', `[chat] stream error: 1 | const err = new TypeError("${address}") ${email}`, registered('chat', 'chat_stream_error', 'error'), { level: 3 }),
  ships('registered message with a variable tail: the tail is dropped', `[exo] retention sweep removed=3 skipped=0 failed=0`, registered('exo', 'exo_retention_sweep_removed', 'info')),
  ships('two registered prefixes match: the longer, more specific one wins', '[chat] failed to record post-stream usage: boom', registered('chat', 'chat_failed_to_record_post_stream_usage', 'error'), { level: 3 }),
  ships('the shorter registered prefix applies when no longer one matches', '[chat] failed to something else: boom', registered('chat', 'chat_failed_to', 'error'), { level: 3 }),
  ships('ledger gate: prose after key=value is a registered fixed message', '[ledger-gate] source=outage_policy policy=fail_open: bypassing K-degrade denial', registered('ledger-gate', 'ledger_gate_failopen_bypass_denial', 'warn'), { level: 3 }),
  ships('webhook receive line: recv is a fixed op, hashes and event names are dropped', `[connector-webhook] recv tid=ab12cd34 sig=ef56 source=fireflies event=Transcription_Done mid=9f9f result=queued queue_result=queued depth=2 t=2026-10-24T00:00:00.000Z`, structured('connector-webhook', { op: 'recv', source: 'fireflies', result: 'queued', depth: 2 })),
  ships('alert=true raises the level to error; correlation ids are dropped', `[private-cloud] status=503 code=service_misconfigured class=operator_fault cid=${uuid} alert=true`, structured('private-cloud', { status: 503, code: 'service_misconfigured', alert: true }, 'error'), { level: 3 }),
  ships('credit gate: the address is dropped even if a call site prints it', `[credit-gate] source=ledger address=${address} committed=10 limit=20 window_kind=week`, structured('credit-gate', { source: 'ledger', window_kind: 'week' }, 'warn'), { level: 3 }),
  ships('key=value lines: waitedMs maps to waited_ms', '[storage-lane] op=slow-wait priority=high waitedMs=2500', structured('storage-lane', { op: 'slow-wait', priority: 'high', waited_ms: 2500 }, 'warn'), { level: 3 }),
  // --- the filter is the guarantee even if a call site is sloppy -----------------------------------------------------------
  ships('an address in a code field is omitted, the rest ships', `[transcript-delivery] op=deliver result=${address}`, structured('transcript-delivery', { op: 'deliver' })),
  ships('a lowercase address in a code field is omitted', `[transcript-delivery] op=deliver result=${address.toLowerCase()} code=ok`, structured('transcript-delivery', { op: 'deliver', code: 'ok' })),
  ships('a JWT in a code field is omitted', `[transcript-delivery] op=deliver reason=${jwt}`, structured('transcript-delivery', { op: 'deliver' })),
  ships('a DID in a code field is omitted', `[transcript-delivery] op=deliver reason=${did}`, structured('transcript-delivery', { op: 'deliver' })),
  ships('an e-mail in a code field is omitted', `[transcript-delivery] op=deliver reason=${email}`, structured('transcript-delivery', { op: 'deliver' })),
  ships('a URL with a query in a code field is omitted', `[transcript-delivery] op=deliver reason=https://example.test/x?token=abc`, structured('transcript-delivery', { op: 'deliver' })),
  ships('a long hex value that starts with a letter is omitted', `[transcript-delivery] op=deliver reason=${hex40}`, structured('transcript-delivery', { op: 'deliver' })),
  ships('a UUID in a code field is omitted', `[transcript-delivery] op=deliver reason=${uuid}`, structured('transcript-delivery', { op: 'deliver' })),
  ships('an over-long code value is omitted', `[transcript-delivery] op=deliver reason=${'a'.repeat(49)}`, structured('transcript-delivery', { op: 'deliver' })),
  droppedLine('uppercase code values are omitted, leaving no attribute: the line is dropped', '[transcript-delivery] op=Deliver result=Written'),
  ships('a non-integer in an integer field is omitted', '[calendar-autojoin] code=tick_done ms=12.5 tenants=-3 rows=abc scans=7', structured('calendar-autojoin', { code: 'tick_done', scans: 7 })),
  ships('an integer longer than 15 digits is omitted', '[calendar-autojoin] code=tick_done ms=1234567890123456 rows=1', structured('calendar-autojoin', { code: 'tick_done', rows: 1 })),
  ships('a boolean field accepts only true or false', '[connector-teardown] op=teardown result=ok upstream=yes credential_deleted=true', structured('connector-teardown', { op: 'teardown', result: 'ok', credential_deleted: true })),
  ships('an enum field outside its list is omitted', '[connector-credential] source=somewhere-else op=x', structured('connector-credential', { op: 'x' })),
  ships('unknown keys are ignored, even with sensitive values', `[connector-ingest] op=cohort-read result=ok mid=${address} aid=${did} error=${jwt} email=${email}`, structured('connector-ingest', { op: 'cohort-read', result: 'ok' })),
  droppedLine('free text is dropped and counted', `Something went wrong for ${email} at ${address}`),
  droppedLine('a tagged line with free text is dropped even when known keys are present', `[transcript-delivery] op=deliver result=written failed for ${email}`),
  droppedLine('an error message in a key=value line with spaces drops the whole line', `[calendar-autojoin] code=exo_teardown outcome=failed error=Error: boom for ${address}`),
  droppedLine('a duplicate known key is ambiguous and drops the line', '[transcript-delivery] op=deliver op=sweep result=written'),
  droppedLine('an unknown component tag is dropped', '[not-a-component] op=deliver result=written'),
  droppedLine('a tagged line with no allow-listed attribute is dropped', '[chat] foo=bar baz=qux'),
  droppedLine('an empty token (double space) is dropped', '[transcript-delivery] op=deliver  result=written'),
  droppedLine('JSON-looking input is dropped', `{"msg":"${email}","address":"${address}"}`),
  droppedLine('a stack frame is dropped', `      at handler (/app/backend/src/routes/chat.ts:510:13)`),
  droppedLine('a stderr line that is not classified is counted as an error', `[nobody-knows] oops ${address}`, 'unclassified_error', { level: 3 }),
  // --- envelope and gate -------------------------------------------------------------------------------------------------
  drops('a line from another container label is rejected', packet('[transcript-delivery] op=deliver result=written', { label: 'tinycloud-ingress' }), 'unexpected_label'),
  drops('an unlabelled packet is rejected', packet('[transcript-delivery] op=deliver result=written', { label: false }), 'unlabelled'),
  drops('a non-JSON packet is rejected', 'not a gelf packet', 'malformed_envelope'),
  drops('a packet with the wrong GELF version is rejected', JSON.stringify({ version: '2.0', short_message: 'x', '_tc.logship': 'tinychat-backend' }), 'malformed_envelope'),
  drops('a non-string short_message is rejected', JSON.stringify({ version: '1.1', short_message: { a: 1 }, '_tc.logship': 'tinychat-backend' }), 'malformed_envelope'),
  drops('a partial packet is rejected', packet('[transcript-delivery] op=deliver result=written', { extra: { partial_message: true } }), 'partial'),
  drops('a line over the size limit is rejected without being parsed', packet(`[transcript-delivery] op=deliver result=written ${'x'.repeat(MAX_LINE_BYTES)}`), 'oversized'),
  ships('a line exactly at the size limit is still classified', atLimit(), structured('transcript-delivery', { op: 'deliver', result: 'written' })),
  // --- guard: defense in depth after the sanitizer ---------------------------------------------------------------------------
  ...[
    ['an address', { op: address }],
    ['a DID', { op: did }],
    ['a JWT', { op: jwt }],
    ['a URL', { op: 'https://example.test/a' }],
    ['an e-mail', { op: email }],
    ['a query string', { op: 'a?b=c' }],
    ['a long hex string', { op: hex40 }],
  ].map(([label, attrs]) => ({
    name: `guard: an event carrying ${label} is dropped and counted`,
    inputs: [{ insert_at: 'guard', type: 'log', log_fields: { ...base, level: 'info', component: 'chat', event_code: 'structured', ts: '2026-10-24T00:00:00.000Z', ...attrs } }],
    no_outputs_from: ['guard'],
    outputs: [{ extract_from: 'gate_counts', conditions: [{ type: 'vrl', source: `assert_eq!(., {"gate_reason": "guard_blocked", "count": 1})` }] }],
  })),
  {
    name: 'guard: a clean event passes unchanged',
    inputs: [{ insert_at: 'guard', type: 'log', log_fields: { ...base, level: 'info', component: 'chat', event_code: 'structured', ts: '2026-10-24T00:00:00.000Z', op: 'deliver', count: 3 } }],
    outputs: [{ extract_from: 'guard', conditions: [{ type: 'vrl', source: `assert!(.event == "backend_log" && .svc == "backend" && .level == "info" && .component == "chat" && .event_code == "structured" && .ts == "2026-10-24T00:00:00.000Z" && .op == "deliver" && .count == 3)` }] }],
  },
  // --- cap ---------------------------------------------------------------------------------------------------------------------
  ...[['a single event', 1, 1], ['exactly the cap', CAP_PER_WINDOW, CAP_PER_WINDOW], ['one over the cap', CAP_PER_WINDOW + 1, CAP_PER_WINDOW], ['ten over the cap', CAP_PER_WINDOW + 10, CAP_PER_WINDOW]].map(([label, sent, kept]) => ({
    name: `cap: ${label}: ${kept} of ${sent} ship, in order`,
    inputs: Array.from({ length: sent }, (_, index) => ({ insert_at: 'cap', type: 'log', log_fields: { ...base, level: 'info', component: 'chat', event_code: 'structured', ts: '2026-10-24T00:00:00.000Z', count: index + 1 } })),
    outputs: [{ extract_from: 'cap', expected_event_count: kept, conditions: Array.from({ length: kept }, (_, index) => ({ type: 'vrl', source: `assert!(.count == ${index + 1})` })) }],
  })),
  {
    name: 'cap: a different component or event_code has its own count',
    inputs: [
      ...Array.from({ length: CAP_PER_WINDOW + 5 }, (_, index) => ({ insert_at: 'cap', type: 'log', log_fields: { ...base, level: 'info', component: 'chat', event_code: 'structured', ts: '2026-10-24T00:00:00.000Z', count: index + 1 } })),
      ...Array.from({ length: 3 }, (_, index) => ({ insert_at: 'cap', type: 'log', log_fields: { ...base, level: 'info', component: 'exo', event_code: 'structured', ts: '2026-10-24T00:00:00.000Z', count: 1000 + index } })),
      ...Array.from({ length: 3 }, (_, index) => ({ insert_at: 'cap', type: 'log', log_fields: { ...base, level: 'error', component: 'chat', event_code: 'chat_stream_error', ts: '2026-10-24T00:00:00.000Z', count: 2000 + index } })),
    ],
    outputs: [{ extract_from: 'cap', expected_event_count: CAP_PER_WINDOW + 6, conditions: [
      { type: 'vrl', source: 'assert!(.component == "exo" && .count == 1002)' },
      { type: 'vrl', source: 'assert!(.event_code == "chat_stream_error" && .count == 2002)' },
    ] }],
  },
];

// --- R4: the cap key includes op and result, so a flood of one result cannot starve another ----------------------------------
const stamp = '2026-10-24T00:00:00.000Z';
const shaped = (attrs, component = 'transcript-delivery') => ({ event: 'backend_log', svc: 'backend', level: 'info', component, event_code: 'structured', ts: stamp, ...attrs });
const insertAtCap = events => events.map(log_fields => ({ insert_at: 'cap', type: 'log', log_fields }));
vectorTests.push(
  {
    name: 'cap: a flood of one result does not starve another result of the same component and op',
    inputs: insertAtCap([
      ...Array.from({ length: CAP_PER_WINDOW + 20 }, (_, index) => shaped({ op: 'deliver', result: 'written', count: index + 1 })),
      ...Array.from({ length: 5 }, (_, index) => shaped({ op: 'deliver', result: 'error', count: 1000 + index })),
      ...Array.from({ length: 3 }, (_, index) => shaped({ op: 'sweep', result: 'unreadable_address', count: 2000 + index })),
    ]),
    outputs: [{ extract_from: 'cap', expected_event_count: CAP_PER_WINDOW + 8, conditions: [
      { type: 'vrl', source: 'assert!(.result == "error" && .count == 1004)' },
      { type: 'vrl', source: 'assert!(.op == "sweep" && .count == 2002)' },
      { type: 'vrl', source: `assert!(.result == "written" && .count == ${CAP_PER_WINDOW})` },
      { type: 'vrl', source: `assert!(.result == "written" && .count == 1)` },
    ] }],
  },
  {
    name: 'cap: lines without op or result are still capped per component and event code',
    inputs: insertAtCap(Array.from({ length: CAP_PER_WINDOW + 7 }, (_, index) => shaped({ count: index + 1 }, 'chat'))),
    outputs: [{ extract_from: 'cap', expected_event_count: CAP_PER_WINDOW, conditions: [{ type: 'vrl', source: `assert!(.count == ${CAP_PER_WINDOW})` }] }],
  },
);

// --- R3: boot failures are registered fixed messages ------------------------------------------------------------------------
const registry = JSON.parse(readFileSync(new URL('./diagnostics.json', import.meta.url), 'utf8')).entries;
for (const entry of registry.filter(candidate => candidate.code.startsWith('startup_'))) {
  vectorTests.push(ships(`boot failure registered: ${entry.code}`, `${entry.text} ${'x'.repeat(10)} 0xAbCdEf0123456789abcdef0123456789abCDef01`, registered(entry.component, entry.code, entry.level), { level: 3 }));
}

// --- volume limits: run with `limits` = { maxLines: 5, dailyBudget: 600 } (render-tests limited) ---------------------------------
const budgetEvent = n => ({ ...shaped({ op: 'o'.repeat(40), count: n }), level: 'info' });
const budgetSize = estimateBytes(budgetEvent(1));
const fits = 3;
// Room for exactly `fits` events plus 70 spare bytes: enough for a tiny event (which proves "stopped" is sticky), too few for the
// next full event or a gate count.
const tinyEvent = { event: 'backend_log', ts: stamp };
export const limitProfile = Object.freeze({ maxLines: 5, dailyBudget: fits * budgetSize + 70 });
if (estimateBytes(tinyEvent) > 70) throw new Error('limit profile: the tiny event must fit in the spare bytes');
const insertAtBudget = events => events.map(log_fields => ({ insert_at: 'test_strip', type: 'log', log_fields }));
const eventCount = (extract_from, expected_event_count, conditions = []) => ({ extract_from, expected_event_count, conditions });
const gateEvent = { ts: stamp, level: 'warn', event: 'logship_gate_summary_total', svc: 'logship', gate_reason: 'oversized', count: 3 };
if (limitProfile.dailyBudget - fits * budgetSize >= estimateBytes(gateEvent)) throw new Error('limit profile: the gate event would still fit; adjust the profile');
const noFlag = { type: 'vrl', source: 'assert!(!exists(._ship))' };
export const limitTests = [
  {
    name: 'stream cap: only the first max_lines events of a window pass, in order',
    inputs: insertAtCap(Array.from({ length: 8 }, (_, index) => shaped({ count: index + 1 }, ['chat', 'exo', 'billing', 'relay', 'agent', 'auth', 'startup', 'credits'][index]))),
    outputs: [eventCount('cap', limitProfile.maxLines, Array.from({ length: limitProfile.maxLines }, (_, index) => ({ type: 'vrl', source: `assert!(.count == ${index + 1})` })))],
  },
  {
    name: `daily budget: ${fits} events of ${budgetSize} bytes fit in ${limitProfile.dailyBudget}; both sinks carry them, without the internal flag`,
    inputs: insertAtBudget(Array.from({ length: fits }, (_, index) => budgetEvent(index + 1))),
    outputs: [eventCount('ship_clean', fits, [noFlag]), eventCount('local_clean', fits, [noFlag])],
  },
  {
    name: 'daily budget: past the budget the log service stops, the local copy continues, and one fixed line is added locally',
    inputs: insertAtBudget(Array.from({ length: fits + 3 }, (_, index) => budgetEvent(index + 1))),
    outputs: [
      eventCount('ship_clean', fits, [noFlag, { type: 'vrl', source: `assert!(to_int!(.count) <= ${fits})` }]),
      eventCount('local_clean', fits + 3 + 1, [
        noFlag,
        { type: 'vrl', source: `assert!(.count == ${fits + 3})` },
        { type: 'vrl', source: `assert_eq!(., {"ts": .ts, "level": "warn", "event": "daily_budget_reached", "svc": "logship", "budget_bytes": ${limitProfile.dailyBudget}})` },
      ]),
    ],
  },
  {
    name: 'daily budget: after it is reached even a tiny event is not shipped, and the fixed line is not repeated',
    inputs: insertAtBudget([...Array.from({ length: fits + 1 }, (_, index) => budgetEvent(index + 1)), tinyEvent, tinyEvent]),
    outputs: [
      eventCount('ship_clean', fits),
      eventCount('local_clean', fits + 1 + 2 + 1, [{ type: 'vrl', source: 'assert!(.event == "daily_budget_reached")' }]),
    ],
  },
  {
    name: 'daily budget: the gate counts are subject to the same budget',
    inputs: insertAtBudget([...Array.from({ length: fits }, (_, index) => budgetEvent(index + 1)), gateEvent]),
    outputs: [eventCount('ship_clean', fits), eventCount('local_clean', fits + 1 + 1, [{ type: 'vrl', source: 'assert!(.event == "logship_gate_summary_total" && .count == 3)' }])],
  },
];
