// Compiles the tinychat-backend log boundary (TC-1978) into one Vector config. The same builder feeds the native
// `vector test`, the cap check, the CI `vector validate` and the VECTOR_CONFIG_JSON embedded in docker-compose.phala.yml,
// so the config that is tested is the config that ships. Pattern: tinycloud-node scripts/tc959-logship.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { MAX_LINE_BYTES, CAP_PER_WINDOW, CAP_WINDOW_SECONDS, DEFAULT_DAILY_BYTE_BUDGET, DEFAULT_MAX_LINES_PER_MINUTE, DAY_SECONDS, MAX_DAILY_BYTE_BUDGET, MAX_DROPPED_LINES } from './limits.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const load = name => JSON.parse(readFileSync(resolve(root, 'log-shipper', name), 'utf8'));
export const vectorImage = 'timberio/vector:0.59.0-alpine@sha256:0e36bc2a290039e9b6a5e92f04bd2f133223506f72d09682c1df16c015172b7a';
/**
 * The ingest host comes from the sealed, non-secret env BETTERSTACK_INGEST_HOST (repo variable TINYCHAT_BETTERSTACK_INGEST_HOST).
 * Vector 0.59 does not interpolate environment variables by default, so the sidecar's entrypoint substitutes this placeholder
 * (after checking the host is a plain *.betterstackdata.com name) when it writes the ship config.
 */
export const INGEST_HOST_PLACEHOLDER = '__INGEST_HOST__';
export const sinkUri = `https://${INGEST_HOST_PLACEHOLDER}/`;
export { MAX_LINE_BYTES, CAP_PER_WINDOW, CAP_WINDOW_SECONDS, DEFAULT_DAILY_BYTE_BUDGET, DEFAULT_MAX_LINES_PER_MINUTE, DAY_SECONDS, MAX_DAILY_BYTE_BUDGET, MAX_DROPPED_LINES };
/** Keys the schema marks as typed attributes. Structural keys are never attributes. */
export const STRUCTURAL = Object.freeze(['svc', 'component', 'event_code', 'error_class', 'gate_reason', 'window_s', 'budget_event', 'budget_mode', 'budget_bytes']);
/** Console keys whose names differ from the schema's snake_case names. */
export const RENAMES = Object.freeze({ waitedMs: 'waited_ms', ids: 'item_count' });
const FORBIDDEN = String.raw`0x[0-9a-fA-F]{40}|did:[a-z0-9]+:|eyJ[A-Za-z0-9_-]{5,}\.|[A-Za-z][A-Za-z0-9+.-]*://|[?&][A-Za-z0-9_]+=|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[0-9a-fA-F]{32,}`;

export function schema() { return load('fields.json').services['tinychat-backend']; }

/** Key classes come from the vendored schema, so a key cannot be shipped without being declared there. */
export function keyClasses(fields = schema().fields) {
  const structural = new Set(STRUCTURAL);
  const names = predicate => Object.entries(fields).filter(([key, def]) => !structural.has(key) && predicate(def)).map(([key]) => key);
  return {
    code: names(def => def.type === 'string'),
    int: names(def => def.type === 'integer'),
    bool: names(def => def.type === 'boolean'),
    enum: Object.fromEntries(Object.entries(fields).filter(([key, def]) => !structural.has(key) && def.type === 'enum').map(([key, def]) => [key, def.values])),
  };
}

export function sanitizeSource() {
  const fields = schema().fields;
  const classes = keyClasses(fields);
  const registry = load('diagnostics.json').entries;
  // Ascending length: when two prefixes match, the longer (more specific) entry is applied last and wins.
  const registryVrl = `registry = ${JSON.stringify([...registry].sort((a, b) => a.text.length - b.text.length || a.text.localeCompare(b.text)).map(entry => [entry.text, entry.code, entry.component, entry.level]))}
for_each(registry) -> |_index, entry| {
  fields = array!(entry)
  if starts_with(line, string!(fields[0])) {
    event_code = string!(fields[1])
    component = string!(fields[2])
    reg_level = string!(fields[3])
  }
}`;
  return readFileSync(resolve(root, 'log-shipper/sanitize.vrl'), 'utf8')
    .replace('__REGISTRY__', registryVrl)
    .replace('__COMPONENTS__', JSON.stringify(fields.component.values.filter(value => !['process', 'object', 'credential-row-count'].includes(value))))
    .replace('__CODE_KEYS__', JSON.stringify(classes.code))
    .replace('__INT_KEYS__', JSON.stringify(classes.int))
    .replace('__BOOL_KEYS__', JSON.stringify(classes.bool))
    .replace('__ENUM_KEYS__', JSON.stringify(Object.fromEntries(Object.entries(classes.enum).filter(([key]) => !['budget_event', 'budget_mode'].includes(key)))))
    .replace('__RENAMES__', JSON.stringify(RENAMES))
    .replace('__BUDGET_EVENTS__', JSON.stringify(fields.budget_event.values))
    .replace('__BUDGET_MODES__', JSON.stringify(fields.budget_mode.values))
    .replace('__ERROR_CLASSES__', JSON.stringify(fields.error_class.values.filter(value => value !== 'other')));
}

const remap = (inputs, source, options = {}) => ({ type: 'remap', inputs, source, drop_on_error: true, drop_on_abort: true, ...options });

/**
 * One `lua` transform applies two per-window caps (window = CAP_WINDOW_SECONDS, the first tick after the first event):
 *   1. every (component, event_code, op, result) passes at most CAP_PER_WINDOW events, so a flood of one result cannot starve
 *      another; past 500 distinct keys in a window the key falls back to (component, event_code) to bound memory;
 *   2. the WHOLE stream passes at most `max_lines` events (BETTERSTACK_MAX_LINES_PER_MINUTE; a number baked in from limits.mjs
 *      and replaced by the sidecar's entrypoint only for a valid positive integer).
 * The rest are counted. When the window ends a timer emits at most MAX_DROPPED_LINES `log_dropped` events (the keys with the
 * most drops) and ONE `log_stream_dropped` event whose count is the whole-stream overflow plus the drops of every key that did
 * not get its own line: fixed shapes built from already-validated key parts and integers; nothing from a dropped event is read.
 * So the lines reaching a sink in a window are at most max_lines + MAX_DROPPED_LINES + 1 (+ the gate summaries): a true ceiling. Vector fires a Lua timer once at the first event, so `flush` ignores that tick.
 * Both caps sit before every sink, so they bound the shipped stream and the local copy alike.
 */
const capTransform = ({ maxLines }) => ({
  type: 'lua', version: '2', inputs: ['guard'],
  hooks: { process: 'process' }, timers: [{ interval_seconds: CAP_WINDOW_SECONDS, handler: 'flush' }],
  source: `local cap = ${CAP_PER_WINDOW}
local max_lines = ${maxLines}
local max_drop_lines = ${MAX_DROPPED_LINES}
local counts = {}
local parts = {}
local dropped = {}
local keys = 0
local total = 0
local stream_dropped = 0
local ticks = 0
function process(event, emit)
  local log = event.log
  local base = log.component .. "|" .. log.event_code
  local key = base
  local op = nil
  local result = nil
  if log.op ~= nil or log.result ~= nil then
    local full = base .. "|" .. (log.op or "") .. "|" .. (log.result or "")
    if counts[full] ~= nil or keys < 500 then
      key = full
      op = log.op
      result = log.result
    end
  end
  local n = counts[key]
  if n == nil then
    n = 0
    keys = keys + 1
    parts[key] = {component = log.component, event_code = log.event_code, op = op, result = result}
  end
  n = n + 1
  counts[key] = n
  if n > cap then
    dropped[key] = (dropped[key] or 0) + 1
    return
  end
  total = total + 1
  if total > max_lines then
    stream_dropped = stream_dropped + 1
    return
  end
  emit(event)
end
function flush(emit)
  ticks = ticks + 1
  if ticks == 1 then return end
  local now = os.date("!%Y-%m-%dT%H:%M:%S.000Z")
  local list = {}
  for key, n in pairs(dropped) do
    list[#list + 1] = {key = key, n = n}
  end
  table.sort(list, function(a, b)
    if a.n ~= b.n then return a.n > b.n end
    return a.key < b.key
  end)
  local folded = 0
  for i, item in ipairs(list) do
    if i <= max_drop_lines then
      local p = parts[item.key]
      emit({log = {ts = now, level = "warn", event = "log_dropped", svc = "backend", component = p.component, event_code = p.event_code, op = p.op, result = p.result, dropped = item.n, window_s = ${CAP_WINDOW_SECONDS}}})
    else
      folded = folded + item.n
    end
  end
  local stream_total = stream_dropped + folded
  if stream_total > 0 then
    emit({log = {ts = now, level = "warn", event = "log_stream_dropped", svc = "backend", dropped = stream_total, window_s = ${CAP_WINDOW_SECONDS}}})
  end
  counts = {}
  parts = {}
  dropped = {}
  keys = 0
  total = 0
  stream_dropped = 0
end`,
});

/**
 * The daily byte budget, in front of the log service sink only. It counts the estimated JSON bytes of every event it
 * lets through to the sink (the same estimate as estimateBytes in limits.mjs, which never under-counts). The first event that
 * would exceed `daily_budget` (BETTERSTACK_DAILY_BYTE_BUDGET, baked in from limits.mjs, replaced by the entrypoint only for
 * a valid positive integer) stops shipping for the rest of the UTC day: every later event is marked _ship=false, and ONE
 * `daily_budget_reached` event (fixed shape, marked _ship=false, so it reaches the local copy only) is emitted. Nothing
 * raises the budget; the counter resets when floor(time / day_seconds) changes (epoch-aligned: 00:00Z). The counter is in
 * memory, so a sidecar restart can re-spend it: the default is sized for a few restarts a day (see limits.mjs).
 */
const budgetTransform = ({ dailyBudget, daySeconds }) => ({
  type: 'lua', version: '2', inputs: ['cap', 'gate_output'],
  hooks: { process: 'process' },
  source: `local daily_budget = ${dailyBudget}
local max_daily_budget = ${MAX_DAILY_BYTE_BUDGET}
local day_seconds = ${daySeconds}
local day = -1
local spent = 0
local stopped = false
local function size(log)
  local n = 3
  for k, v in pairs(log) do
    n = n + #k + 6
    if type(v) == "string" then
      n = n + #v + 2
    else
      n = n + #tostring(v)
    end
  end
  return n
end
function process(event, emit)
  local today = math.floor(os.time() / day_seconds)
  if today ~= day then
    day = today
    spent = 0
    stopped = false
  end
  local n = size(event.log)
  if not stopped and spent + n <= daily_budget then
    spent = spent + n
    event.log._ship = true
    emit(event)
  else
    event.log._ship = false
    emit(event)
    if not stopped then
      stopped = true
      emit({log = {ts = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), level = "warn", event = "daily_budget_reached", svc = "logship", budget_bytes = daily_budget, _ship = false}})
    end
  end
end`,
});

/**
 * The only inputs the sinks have. Both come from the filtered stream and the content-free gate counts (cap, gate_output),
 * through the daily budget; `ship_clean` is what the budget lets through to the log service, `local_clean` is everything
 * (the local copy keeps going after the budget is reached). Never a raw stage.
 */
export const SINK_INPUTS = Object.freeze({ local: Object.freeze(['local_clean']), betterstack: Object.freeze(['ship_clean']) });

/**
 * Two parts, so the sidecar can run without a token. `base` is the whole boundary plus a local sink that prints the SAME
 * filtered stream as JSON lines to the container's stdout (rotated by Docker's json-file driver). `ship` adds the
 * Better Stack sink and its secret; the sidecar loads it only when a token and a valid ingest host are present.
 */
export function buildParts({ uri = sinkUri, dataDir = '/var/lib/vector', sourceAddress = '0.0.0.0:12201', token, limits = {} } = {}) {
  const { maxLines = DEFAULT_MAX_LINES_PER_MINUTE, dailyBudget = DEFAULT_DAILY_BYTE_BUDGET, daySeconds = DAY_SECONDS } = limits;
  const gateReasons = schema().fields.gate_reason.values;
  const base = {
    data_dir: dataDir,
    sources: { gelf_in: {
      type: 'socket', mode: 'udp', address: sourceAddress, max_length: 262144, receive_buffer_bytes: 8388608,
      framing: { method: 'chunked_gelf', chunked_gelf: { decompression: 'Auto' } }, decoding: { codec: 'bytes' },
    } },
    transforms: {
      // Parse GELF ourselves: native decoder errors can echo malformed values. Only the label, the level and the line survive.
      gelf_envelope: remap(['gelf_in'], `packet = string(.message) ?? ""
if length(packet) > 262144 {
  . = {"reason": "oversized"}
} else {
  outer, err = parse_json(packet)
  if err != null || !is_object(outer) || (outer.version != "1.1" && outer.version != "1.0") {
    . = {"reason": "malformed_envelope"}
  } else if exists(outer.partial_message) || exists(outer._partial_message) {
    . = {"reason": "partial"}
  } else {
    label = get(outer, ["_tc.logship"]) ?? null
    . = {"_tc.logship": label, "message": outer.short_message, "gl": outer.level}
  }
}`),
      logship_gate: remap(['gelf_envelope'], `if exists(.reason) {
  . = {"reason": .reason}
} else {
  label = string(get(., ["_tc.logship"]) ?? null) ?? ""
  raw = .message
  reason = ""
  if label == "" { reason = "unlabelled" }
  else if label != "tinychat-backend" { reason = "unexpected_label" }
  else if !is_string(raw) { reason = "malformed_envelope" }
  else if length(string!(raw)) > ${MAX_LINE_BYTES} { reason = "oversized" }
  if reason != "" {
    . = {"reason": reason}
  } else {
    . = {"line": string!(raw), "gl": int(.gl) ?? 6}
  }
}`),
      gate_route: { type: 'route', inputs: ['logship_gate'], route: { candidate: 'exists(.line)', rejected: 'exists(.reason)' } },
      allowlist: remap(['gate_route.candidate'], sanitizeSource(), { reroute_dropped: true }),
      // Defense in depth: the sanitizer builds its object from typed values only, so this never fires on a correct
      // sanitizer. If a future change lets an address, DID, token, URL, query, e-mail or long hex string through, the
      // event is dropped and counted instead of shipped.
      guard: remap(['allowlist'], `if match(encode_json(.), r'${FORBIDDEN}') { abort }`, { reroute_dropped: true }),
      gate_counts: remap(['gate_route.rejected', 'gate_route._unmatched', 'allowlist.dropped', 'guard.dropped'], `reason = string(.reason) ?? ""
if reason == "" {
  reason = if (int(.gl) ?? 6) <= 3 { "unclassified_error" } else { "unclassified_info" }
  if exists(.event) { reason = "guard_blocked" }
}
if !includes(${JSON.stringify(gateReasons)}, reason) { reason = "malformed_envelope" }
. = {"gate_reason": reason, "count": 1}`),
      gate_reduce: { type: 'reduce', inputs: ['gate_counts'], group_by: ['gate_reason'], end_every_period_ms: 60000, expire_after_ms: 75000, flush_period_ms: 1000, merge_strategies: { count: 'sum' } },
      gate_output: remap(['gate_reduce'], `. = {"ts": format_timestamp!(now(), format: "%Y-%m-%dT%H:%M:%S%.3fZ"), "level": "warn", "event": "logship_gate_summary_total", "svc": "logship", "gate_reason": .gate_reason, "count": .count}`),
      cap: capTransform({ maxLines }),
      budget: budgetTransform({ dailyBudget, daySeconds }),
      budget_route: { type: 'route', inputs: ['budget'], route: { ship: '._ship == true' } },
      ship_clean: remap(['budget_route.ship'], 'del(._ship)'),
      local_clean: remap(['budget_route.ship', 'budget_route._unmatched'], 'del(._ship)'),
    },
    sinks: { local: { type: 'console', inputs: [...SINK_INPUTS.local], target: 'stdout', encoding: { codec: 'json' } } },
  };
  const ship = {
    sinks: { betterstack: {
      type: 'http', inputs: [...SINK_INPUTS.betterstack], method: 'post', uri,
      encoding: { codec: 'json' }, framing: { method: 'newline_delimited' }, compression: 'gzip',
      auth: { strategy: 'bearer', token: token ?? 'SECRET[bs.bs_token]' },
      batch: { max_bytes: 262144, timeout_secs: 1 },
      buffer: { type: 'memory', max_events: 1000, when_full: 'block' },
      request: { timeout_secs: 10, retry_max_duration_secs: 300 },
      healthcheck: { enabled: false },
    } },
  };
  if (token === undefined) ship.secret = { bs: { type: 'directory', path: `${dataDir}/secrets`, remove_trailing_whitespace: true } };
  return { base, ship };
}

/** Both parts as one config, for native tests, the cap check and validation. */
export function buildConfig(options) {
  const { base, ship } = buildParts(options);
  return { ...base, ...(ship.secret ? { secret: ship.secret } : {}), sinks: { ...base.sinks, ...ship.sinks } };
}

/** The compose value: every `$` doubled, because Compose interpolates `$` in environment values. */
export const composeEmbed = config => JSON.stringify(JSON.stringify(config).replaceAll('$', () => '$$'));
/** Undo composeEmbed for a YAML-parsed compose value. */
export const parseComposeEmbed = value => JSON.parse(value.replaceAll('$$', '$'));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, output, option] = process.argv.slice(2);
  if (command === 'sync-compose' && output) {
    const text = readFileSync(output, 'utf8');
    const { base, ship } = buildParts();
    const next = text
      .replace(/^(\s+VECTOR_CONFIG_JSON: ).*$/m, (_, prefix) => `${prefix}${composeEmbed(base)}`)
      .replace(/^(\s+VECTOR_SHIP_JSON: ).*$/m, (_, prefix) => `${prefix}${composeEmbed(ship)}`);
    if (next === text) console.log('compose already in sync'); else { writeFileSync(output, next); console.log('compose updated'); }
    process.exit(0);
  }
  if (!['render-vector', 'render-tests'].includes(command) || !output) throw new Error('usage: build.mjs render-tests OUTPUT [limited] | render-vector OUTPUT [LOCAL_SINK_URI] | sync-compose COMPOSE_FILE');
  const limited = command === 'render-tests' && option === 'limited';
  const { vectorTests, limitTests, limitProfile } = command === 'render-tests' ? await import('./cases.mjs') : {};
  const config = buildConfig(command === 'render-vector' && option ? { uri: option, token: 'tc1978-synthetic-only' } : limited ? { limits: limitProfile } : {});
  if (command === 'render-tests') {
    delete config.secret;
    config.sinks.betterstack.auth = { strategy: 'bearer', token: 'tc1978-synthetic-only' };
    // Same inputs as the real sink: dropping a route from the real sink must not stay green here.
    config.sinks = { discard: { type: 'blackhole', inputs: [...config.sinks.betterstack.inputs, ...config.sinks.local.inputs] } };
    if (limited) {
      // `vector test` adds `message` and `timestamp` to inserted events; the real pipeline has neither, and the budget counts
      // bytes, so the limited cases insert at `test_strip`, which removes them in front of the budget.
      config.transforms.test_strip = remap(['cap', 'gate_output'], 'del(.message)\ndel(.timestamp)');
      config.transforms.budget.inputs = ['test_strip'];
    }
    config.tests = limited ? limitTests : vectorTests;
  }
  writeFileSync(output, JSON.stringify(config, null, 2) + '\n');
}
