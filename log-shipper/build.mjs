// Compiles the tinychat-backend log boundary (TC-1978) into one Vector config. The same builder feeds the native
// `vector test`, the cap check, the CI `vector validate` and the VECTOR_CONFIG_JSON embedded in docker-compose.phala.yml,
// so the config that is tested is the config that ships. Pattern: tinycloud-node scripts/tc959-logship.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { MAX_LINE_BYTES, CAP_PER_WINDOW, CAP_WINDOW_SECONDS } from './limits.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const load = name => JSON.parse(readFileSync(resolve(root, 'log-shipper', name), 'utf8'));
export const vectorImage = 'timberio/vector:0.59.0-alpine@sha256:0e36bc2a290039e9b6a5e92f04bd2f133223506f72d09682c1df16c015172b7a';
/** Better Stack source "tinychat-backend" (ops/betterstack/sources.json): an ingest host, not a secret. */
export const sinkUri = 'https://s2795438.us-west-2a.betterstackdata.com/';
export { MAX_LINE_BYTES, CAP_PER_WINDOW, CAP_WINDOW_SECONDS };
/** Keys the schema marks as typed attributes. Structural keys are never attributes. */
export const STRUCTURAL = Object.freeze(['svc', 'component', 'event_code', 'error_class', 'gate_reason', 'window_s', 'budget_event', 'budget_mode']);
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
 * One `lua` transform caps every (component, event_code) at CAP_PER_WINDOW events per window. The first events of a
 * window pass unchanged; the rest are counted, and when the window ends a timer emits one `log_dropped` event per
 * key that overflowed. The dropped event is built from the already-validated key parts and an integer; nothing from a
 * dropped event is read. Vector fires a Lua timer once at the first event, so `flush` ignores that first tick.
 */
const capTransform = {
  type: 'lua', version: '2', inputs: ['guard'],
  hooks: { process: 'process' }, timers: [{ interval_seconds: CAP_WINDOW_SECONDS, handler: 'flush' }],
  source: `local cap = ${CAP_PER_WINDOW}
local counts = {}
local dropped = {}
local ticks = 0
function process(event, emit)
  local key = event.log.component .. "|" .. event.log.event_code
  local n = (counts[key] or 0) + 1
  counts[key] = n
  if n <= cap then
    emit(event)
  else
    dropped[key] = (dropped[key] or 0) + 1
  end
end
function flush(emit)
  ticks = ticks + 1
  if ticks == 1 then return end
  for key, n in pairs(dropped) do
    local sep = string.find(key, "|", 1, true)
    emit({log = {ts = os.date("!%Y-%m-%dT%H:%M:%S.000Z"), level = "warn", event = "log_dropped", svc = "backend", component = string.sub(key, 1, sep - 1), event_code = string.sub(key, sep + 1), dropped = n, window_s = ${CAP_WINDOW_SECONDS}}})
  end
  counts = {}
  dropped = {}
end`,
};

/** Compile one boundary for native tests, the cap check, validation and the compose. */
export function buildConfig({ uri = sinkUri, dataDir = '/var/lib/vector', sourceAddress = '0.0.0.0:12201', token } = {}) {
  const gateReasons = schema().fields.gate_reason.values;
  const config = {
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
      cap: capTransform,
    },
    sinks: { betterstack: {
      type: 'http', inputs: ['cap', 'gate_output'], method: 'post', uri,
      encoding: { codec: 'json' }, framing: { method: 'newline_delimited' }, compression: 'gzip',
      auth: { strategy: 'bearer', token: token ?? 'SECRET[bs.bs_token]' },
      batch: { max_bytes: 262144, timeout_secs: 1 },
      buffer: { type: 'memory', max_events: 1000, when_full: 'block' },
      request: { timeout_secs: 10, retry_max_duration_secs: 300 },
      healthcheck: { enabled: false },
    } },
  };
  if (token === undefined) config.secret = { bs: { type: 'directory', path: `${dataDir}/secrets`, remove_trailing_whitespace: true } };
  return config;
}

/** The compose value: every `$` doubled, because Compose interpolates `$` in environment values. */
export const composeEmbed = (config = buildConfig()) => JSON.stringify(JSON.stringify(config).replaceAll('$', () => '$$'));
/** Undo composeEmbed for a YAML-parsed compose value. */
export const parseComposeEmbed = value => JSON.parse(value.replaceAll('$$', '$'));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, output, option] = process.argv.slice(2);
  if (command === 'sync-compose' && output) {
    const text = readFileSync(output, 'utf8');
    const next = text.replace(/^(\s+VECTOR_CONFIG_JSON: ).*$/m, (_, prefix) => `${prefix}${composeEmbed()}`);
    if (next === text) console.log('compose already in sync'); else { writeFileSync(output, next); console.log('compose updated'); }
    process.exit(0);
  }
  if (!['render-vector', 'render-tests'].includes(command) || !output) throw new Error('usage: build.mjs render-tests OUTPUT | render-vector OUTPUT [LOCAL_SINK_URI] | sync-compose COMPOSE_FILE');
  const config = buildConfig(command === 'render-vector' && option ? { uri: option, token: 'tc1978-synthetic-only' } : {});
  if (command === 'render-tests') {
    delete config.secret;
    config.sinks.betterstack.auth = { strategy: 'bearer', token: 'tc1978-synthetic-only' };
    // Same inputs as the real sink: dropping a route from the real sink must not stay green here.
    config.sinks = { discard: { type: 'blackhole', inputs: [...config.sinks.betterstack.inputs] } };
    const { vectorTests } = await import('./cases.mjs');
    config.tests = vectorTests;
  }
  writeFileSync(output, JSON.stringify(config, null, 2) + '\n');
}
