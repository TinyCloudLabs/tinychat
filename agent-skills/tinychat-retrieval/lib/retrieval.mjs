import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, chmod, writeFile, readFile, stat, lstat, open, rm } from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute, normalize } from 'node:path';

const PACK = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
export const PACK_VERSION = PACK.version;

const parseSemver = version => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return null;
  return { core: match.slice(1, 4).map(BigInt), prerelease };
};

export function compareSemver(left, right) {
  const a = parseSemver(left), b = parseSemver(right);
  if (!a || !b) return NaN;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (!a.prerelease || !b.prerelease) return a.prerelease === b.prerelease ? 0 : a.prerelease ? -1 : 1;
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x), yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}
export const DATABASE = 'xyz.tinycloud.tinychat/connectors';
const SOURCES = ['fireflies', 'google-meet', 'tinycloud-transcriber', 'exo-local', 'exo-voice-note', 'exo-upload'];
const PENDING_SNAPSHOT_KEY = `${DATABASE}/pending-reconcile-snapshot`;
const PENDING_SNAPSHOT_MAX_BYTES = 1024 * 1024;
const PENDING_SNAPSHOT_FIELDS = new Set(['version', 'changed_at', 'checked_at', 'count', 'meetings']);
const PENDING_MEETING_FIELDS = new Set(['id', 'source', 'ts', 'storedAt', 'updatedAt', 'createdAt', 'startedAt', 'endedAt', 'completedAt', 'status', 'reconciled']);
const PENDING_TIMESTAMP_FIELDS = ['ts', 'storedAt', 'updatedAt', 'createdAt', 'startedAt', 'endedAt', 'completedAt'];
const COLUMNS = ['id', 'source', 'source_id', 'title', 'started_at', 'organizer_email', 'participants', 'summary_overview', 'summary_action_items', 'metadata', 'updated_at', 'sort_time'];
const LEGACY_WINNER_FILTER_SQL = "g.source IN ('exo-voice-note', 'exo-voice-note-dup') AND json_valid(g.metadata) AND json_extract(g.metadata, '$.transcription_outcome') IS NOT NULL";
const LEGACY_WINNER_ORDER_SQL = "ORDER BY COALESCE(json_extract(g.metadata, '$.transcribed_at'), '') DESC, g.id ASC LIMIT 1";
// sqlparser-rs rejects SQLite's two-argument TRIM; use this ECMAScript WhiteSpace ∪ LineTerminator set with nested LTRIM/RTRIM (https://tc39.es/ecma262/multipage/text-processing.html#sec-trimstring).
const SQL_ECMASCRIPT_TRIM_CHARS = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
// Limit display-only fields at the query boundary; identity and classification fields stay exact.
const PROJECTION = COLUMNS.map(c => ['title', 'organizer_email', 'participants', 'summary_overview', 'summary_action_items'].includes(c) ? `substr(${c},1,600) AS ${c}` : c === 'sort_time' ? 'julianday(started_at) AS sort_time' : c).join(', ');
const MESSAGES = {
  ACQUISITION_EXISTS: 'The acquisition directory already exists. Preserve it and start a new acquisition directory.',
  ACQUISITION_INVALID: 'The saved acquisition is incomplete, changed, unsafe or bound to another operation. Restart with a new acquisition directory.',
  INVALID_INPUT: 'Invalid arguments. Use --help for supported filters and limits.',
  INVALID_RESPONSE: 'The CLI response did not match the supported data contract.',
  INVALID_METADATA: 'The catalog contains unsupported or unsafe source metadata.',
  AUTH_REQUIRED: 'The selected CLI profile has no usable session. Complete terminal authentication.',
  AUTH_EXPIRED: 'The selected authorization has expired. Renew it through terminal consent.',
  AUTH_OR_PERMISSION: 'The server rejected authorization without distinguishing authentication from permission. Inspect the selected profile and requested grant; do not assume a new login is needed.',
  PERMISSION_DENIED: 'The selected session lacks permission for this read. Inspect its grant.',
  OWNER_MISMATCH: 'The profile owner differs from --owner. Select the same identity as TinyChat.',
  CONTEXT_MISMATCH: 'This reference or continuation belongs to a different profile, host, or space.',
  SOURCE_CHANGED: 'The catalog identity changed. Discover and select the record again.',
  REVISION_CHANGED: 'The body changed between pages. Restart this exact read or search; do not combine revisions.',
  MEETING_NOT_FOUND: 'The selected catalog record no longer exists in this space.',
  MISSING_BODY: 'The catalog record exists but its stored body was not found.',
  EMPTY_BODY: 'The stored body contains no readable text. This is not a complete meeting read.',
  TRANSCRIPT_OMITTED: 'No transcript text is available for this voice note.',
  UNSUPPORTED_FORMAT: 'The stored body contains an unsupported format or record. No text was silently omitted.',
  UNSUPPORTED_SOURCE: 'This source is not supported by this release.',
  SPACE_NOT_HOSTED: 'The selected space is not available on this host.',
  NETWORK_ERROR: 'The CLI could not reach the selected host.',
  OUTPUT_LIMIT: 'This result exceeds the supported byte budget. Narrow the scope or reduce the page size.',
  TIMEOUT: 'The read exceeded its execution deadline.',
  CANCELLED: 'The read was cancelled.',
  CLI_UNAVAILABLE: 'TinyCloud CLI was not found. Install the supported release or supply --tc.',
  CLI_VERSION: 'TinyCloud CLI 0.9.0 or later is required. Setup requires 0.10.0 or later.',
  CLI_ERROR: 'The CLI read failed. Inspect local diagnostics; raw CLI errors are not returned.',
};
export class RetrievalError extends Error {
  constructor(code, detail) { super(detail === undefined ? MESSAGES[code] ?? MESSAGES.CLI_ERROR : `${MESSAGES[code] ?? MESSAGES.CLI_ERROR} Source: ${detail}.`); this.code = code; }
}
const fail = (code, detail) => { throw new RetrievalError(code, detail); };
const omitTranscript = (row, reason) => {
  const error = new RetrievalError('TRANSCRIPT_OMITTED');
  error.reason = reason;
  error.omission = { id: row.id, source: row.source, started_at: row.started_at, reason };
  throw error;
};
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
const integer = (v, low, high) => Number.isSafeInteger(v) && v >= low && v <= high;
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const safeId = v => typeof v === 'string' && v.length > 0 && bytes(v) <= 4096 && !/[\u0000-\u001f\u007f]/u.test(v);
const safeSegment = v => safeId(v) && !/[\\/%?#]/u.test(v) && !v.includes('..');
function parse(raw) { try { return JSON.parse(raw); } catch { fail('INVALID_RESPONSE'); } }
function classified(error) {
  if (error instanceof RetrievalError) return error;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return new RetrievalError('CANCELLED');
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new RetrievalError('OUTPUT_LIMIT');
  if (error?.killed || error?.signal) return new RetrievalError('TIMEOUT');
  if (error?.code === 'ENOENT') return new RetrievalError('CLI_UNAVAILABLE');
  let detail; try { detail = JSON.parse(error?.stderr ?? '').error; } catch { /* Never expose arbitrary CLI text. */ }
  let code = detail?.code;
  const status = detail?.meta?.status ?? detail?.status;
  if (status === 403 || ['SQL_PERMISSION_DENIED', 'KV_PERMISSION_DENIED', 'ACCESS_DENIED'].includes(code)) code = 'PERMISSION_DENIED';
  if (status === 401) code = 'AUTH_REQUIRED';
  if (code === 'AUTH_UNAUTHORIZED') code = 'AUTH_OR_PERMISSION';
  if (['NOT_FOUND', 'KV_NOT_FOUND'].includes(code)) code = 'MISSING_BODY';
  if (!Object.hasOwn(MESSAGES, code)) code = { 3: 'AUTH_REQUIRED', 4: 'MISSING_BODY', 5: 'PERMISSION_DENIED', 6: 'NETWORK_ERROR' }[error?.code] ?? 'CLI_ERROR';
  return new RetrievalError(code);
}

/** Only a literal executable and argument vector; never a shell or transcript-provided command. */
export function createTcRunner({ executable = 'tc', timeoutMs = 30000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return (args, { signal, outputFile, maxOutputBytes } = {}) => new Promise((resolve, reject) => {
    let tooLarge = false;
    const child = execFile(executable, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer, signal, windowsHide: true }, (error, stdout, stderr) => {
      clearInterval(watch);
      if (tooLarge) { reject(new RetrievalError('OUTPUT_LIMIT')); return; }
      if (error) { reject(classified(Object.assign(error, { stderr }))); return; }
      resolve(stdout);
    });
    const watch = outputFile ? setInterval(() => {
      stat(outputFile).then(s => { if (s.size > maxOutputBytes) { tooLarge = true; child.kill(); } }).catch(() => {});
    }, 25) : undefined;
    watch?.unref();
  });
}
function timestamp(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) return false;
  const date = new Date(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === v.slice(0, 10);
}
function keys(input, allowed) { if (!object(input) || Object.keys(input).some(k => !allowed.includes(k))) fail('INVALID_INPUT'); }
function filters(input, search = false) {
  if (input.term !== undefined && (typeof input.term !== 'string' || input.term.length > 500 || (search && !input.term.trim()))) fail('INVALID_INPUT');
  if (search && input.term === undefined) fail('INVALID_INPUT');
  if (input.source !== undefined && !SOURCES.includes(input.source)) fail('INVALID_INPUT');
  if ((input.from !== undefined && !timestamp(input.from)) || (input.to !== undefined && !timestamp(input.to)) || (input.from && input.to && Date.parse(input.from) >= Date.parse(input.to))) fail('INVALID_INPUT');
  if (input.limit !== undefined && !integer(input.limit, 1, 50)) fail('INVALID_INPUT');
  if (input.scanLimit !== undefined && !integer(input.scanLimit, 1, 20)) fail('INVALID_INPUT');
  return { ...(input.term === undefined ? {} : { term: input.term }), ...(input.source === undefined ? {} : { source: input.source }), ...(input.from === undefined ? {} : { from: input.from }), ...(input.to === undefined ? {} : { to: input.to }), limit: input.limit ?? 10, ...(search ? { scanLimit: input.scanLimit ?? 5 } : {}) };
}
function validateAfter(after) { if (after !== null && (!object(after) || !safeId(after.id) || !(after.time === null || typeof after.time === 'number' && Number.isFinite(after.time)))) fail('INVALID_INPUT'); }
function makeQuery(scope, after, limit, bodySearch = false, supportedOnly = false, transcriptOnly = false, voiceNoteCommitTableAvailable = false) {
  const terms = ["(source IS NULL OR source != 'exo-voice-note-dup')"], params = [];
  if (supportedOnly) { terms.push(`source IN (${SOURCES.map(() => '?').join(',')})`); params.push(...SOURCES); }
  if (transcriptOnly) {
    const legacyWinnerId = `(SELECT g.id FROM connector_meeting g WHERE g.source_id = connector_meeting.source_id AND ${LEGACY_WINNER_FILTER_SQL} ${LEGACY_WINNER_ORDER_SQL})`;
    const legacyAdmission = `EXISTS (SELECT 1 FROM connector_meeting g WHERE g.id = ${legacyWinnerId} AND g.source_id = connector_meeting.source_id AND json_extract(g.metadata, '$.transcription_outcome') = 'transcribed' AND json_type(g.metadata, '$.transcript_text') = 'text' AND rtrim(ltrim(json_extract(g.metadata, '$.transcript_text'), ${SQL_ECMASCRIPT_TRIM_CHARS}), ${SQL_ECMASCRIPT_TRIM_CHARS}) != '')`;
    const admission = voiceNoteCommitTableAvailable
      ? `(CASE WHEN EXISTS (SELECT 1 FROM voice_note_transcript t WHERE t.source_id = connector_meeting.source_id) THEN EXISTS (SELECT 1 FROM voice_note_transcript t WHERE t.source_id = connector_meeting.source_id AND t.outcome = 'transcribed') ELSE ${legacyAdmission} END)`
      : legacyAdmission;
    terms.push(`(source != 'exo-voice-note' OR ${admission})`);
  }
  if (scope.term && !bodySearch) { const fields = ['title', 'organizer_email', 'participants', 'summary_overview', 'summary_action_items']; terms.push(`(${fields.map(f => `instr(lower(coalesce(${f},'')),lower(?)) > 0`).join(' OR ')})`); params.push(...fields.map(() => scope.term)); }
  if (scope.source) { terms.push('source = ?'); params.push(scope.source); }
  if (scope.from) { terms.push('julianday(started_at) >= julianday(?)'); params.push(scope.from); }
  if (scope.to) { terms.push('julianday(started_at) < julianday(?)'); params.push(scope.to); }
  if (after) {
    if (after.time === null) { terms.push('(julianday(started_at) IS NULL AND id > ?)'); params.push(after.id); }
    else { terms.push('(julianday(started_at) < ? OR (julianday(started_at) = ? AND id > ?) OR julianday(started_at) IS NULL)'); params.push(after.time, after.time, after.id); }
  }
  params.push(limit);
  return { sql: `SELECT ${PROJECTION} FROM connector_meeting${terms.length ? ` WHERE ${terms.join(' AND ')}` : ''} ORDER BY julianday(started_at) IS NULL ASC, julianday(started_at) DESC, id ASC LIMIT ?`, params };
}
function rows(raw) {
  const r = parse(raw);
  if (!Array.isArray(r?.columns) || r.columns.join(',') !== COLUMNS.join(',') || !Array.isArray(r.rows) || r.rows.some(row => !Array.isArray(row) || row.length !== COLUMNS.length)) fail('INVALID_RESPONSE');
  return r.rows.map(row => Object.fromEntries(COLUMNS.map((c, i) => [c, row[i]])));
}
function metadata(row) {
  if (!safeId(row.id) || !safeSegment(row.source_id)) fail('INVALID_METADATA');
  if (!safeId(row.source)) fail('INVALID_METADATA');
  if (!SOURCES.includes(row.source)) fail('UNSUPPORTED_SOURCE', row.source);
  let extra; try { extra = row.metadata === null ? {} : JSON.parse(row.metadata); } catch { fail('INVALID_METADATA'); }
  if (!object(extra)) fail('INVALID_METADATA');
  validateAfter({ id: row.id, time: row.sort_time });
  const kind = row.source === 'google-meet' && extra.notes_kind === 'gemini' && extra.notes_association !== 'conference' ? 'generated-notes' : 'transcript';
  return { ...row, extra, contentKind: kind };
}
const position = row => ({ id: row.id, time: row.sort_time });
// Offsets are UTF-16 in each original text record, never in speaker/timestamp decoration.
export function decodeBody(raw, source) {
  let value; try { value = JSON.parse(raw); } catch { fail('UNSUPPORTED_FORMAT'); }
  const records = typeof value === 'string' ? [{ text: value }] : value;
  if (!Array.isArray(records) || records.some(r => !object(r) || typeof r.text !== 'string')) fail('UNSUPPORTED_FORMAT');
  if (!records.some(r => r.text.trim())) fail('EMPTY_BODY');
  return records.map((r, recordIndex) => {
    const speaker = [r.speaker_name, r.speaker, r.speakerName].find(v => typeof v === 'string' && v.trim());
    const startSecs = [r.start_time, r.startTime, r.start].find(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
    return { text: r.text, recordIndex, start: 0, end: r.text.length, ...(speaker ? { speaker, ...(source === 'exo-local' ? { speakerKind: 'channel' } : {}) } : {}), ...(startSecs === undefined ? {} : { startSecs }) };
  });
}
function boundary(text, end) {
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end]) ? end - 1 : end;
}

export function createRetrieval({ profile, host, space, owner, tc, runTc = createTcRunner({ executable: tc }), bodyBytes = 8 * 1024 * 1024, envelopeBytes = 24000, signal, acquisitionDir, acquisitionBinding } = {}) {
  let context, contextHash, cliVersion, transfers, readAccess, createdAcquisition;
  function validateContext() {
    if (!safeSegment(profile) || typeof host !== 'string' || typeof owner !== 'string' || !/^did:pkh:eip155:[1-9][0-9]*:0x[a-fA-F0-9]{40}$/.test(owner) || typeof space !== 'string' || !space || bytes(space) > 1000 || !integer(bodyBytes, 1, 64 * 1024 * 1024) || !integer(envelopeBytes, 4000, 40000)) fail('INVALID_INPUT');
    let url; try { url = new URL(host); } catch { fail('INVALID_INPUT'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('INVALID_INPUT');
    const canonicalOwner = owner.toLowerCase();
    const uri = `tinycloud:${canonicalOwner.slice(4)}:${space}`;
    if (!/^[A-Za-z0-9_-]+$/.test(space) && !space.toLowerCase().startsWith(`tinycloud:${canonicalOwner.slice(4)}:`)) fail('CONTEXT_MISMATCH');
    context = { profile, host: url.origin, space: space.startsWith('tinycloud:') ? space : uri, owner: canonicalOwner };
    contextHash = digest(JSON.stringify(context));
    if (acquisitionDir !== undefined || acquisitionBinding !== undefined) {
      if (typeof acquisitionDir !== 'string' || !isAbsolute(acquisitionDir) || normalize(acquisitionDir) !== acquisitionDir || acquisitionDir.includes('\0') || typeof acquisitionBinding !== 'string' || !/^[a-f0-9]{64}$/.test(acquisitionBinding)) fail('INVALID_INPUT');
    }
  }
  const base = () => ['--profile', context.profile, '--host', context.host, '--json'];
  const run = (args, options = {}) => runTc([...base(), ...args], { signal, ...options });
  const unknownPending = checkedAt => ({ count: null, unknown: null, checked_at: checkedAt, freshness: 'unknown' });
  let backendPending = {
    'backend-ingest': unknownPending(null),
    transcriber: unknownPending(null),
  };
  async function readPendingSource(source) {
    let directory;
    try {
      directory = await mkdtemp(join(tmpdir(), 'tinychat-pending-'));
      await chmod(directory, 0o700);
      const outputFile = join(directory, 'snapshot');
      await writeFile(outputFile, '', { flag: 'wx', mode: 0o600 });
      await run(['kv', 'get', `${PENDING_SNAPSHOT_KEY}/${source}`, '--space', context.space, '--output', outputFile], {
        outputFile,
        maxOutputBytes: PENDING_SNAPSHOT_MAX_BYTES,
      });
      const bytes = await privateFile(outputFile, PENDING_SNAPSHOT_MAX_BYTES);
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      let value;
      try { value = JSON.parse(raw); } catch { return unknownPending(null); }
      if (!object(value) || value.version !== 1) return unknownPending(null);
      const checkedAt = typeof value.checked_at === 'string' && timestamp(value.checked_at) ? value.checked_at : null;
      if (Object.keys(value).some(field => !PENDING_SNAPSHOT_FIELDS.has(field))
        || !timestamp(value.changed_at) || checkedAt === null
        || !Array.isArray(value.meetings) || !integer(value.count, 0, Number.MAX_SAFE_INTEGER)
        || value.count !== value.meetings.length) return unknownPending(checkedAt);
      const unknownCount = value.meetings.reduce((count, meeting) => {
        if (!object(meeting) || Object.keys(meeting).some(field => !PENDING_MEETING_FIELDS.has(field))
          || !safeId(meeting.id) || !safeId(meeting.source) || meeting.reconciled !== false
          || !['unreconciled', 'completed', 'unknown'].includes(meeting.status)
          || PENDING_TIMESTAMP_FIELDS.some(field => meeting[field] !== undefined && typeof meeting[field] !== 'string')) {
          throw new Error('INVALID_PENDING_SNAPSHOT');
        }
        return count + Number(meeting.status === 'unknown');
      }, 0);
      const age = Date.now() - Date.parse(checkedAt);
      if (age < 0) return unknownPending(checkedAt);
      const stale = source === 'backend-ingest' ? age > 24 * 60 * 60 * 1000 : age > 60 * 60 * 1000 + 30 * 1000;
      return { count: stale ? null : value.count, unknown: stale ? null : unknownCount, checked_at: checkedAt, freshness: stale ? 'stale' : 'fresh' };
    } catch {
      return unknownPending(null);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  async function readBackendPending() {
    const [backendIngest, transcriber] = await Promise.all([
      readPendingSource('backend-ingest'),
      readPendingSource('transcriber'),
    ]);
    return { 'backend-ingest': backendIngest, transcriber };
  }
  const coverage = extra => ({ catalog: 'connector_meeting SQL rows with legacy KV bodies', excludedCatalogs: ['user-kv-only'], backendPending, corpusComplete: false, scope: 'observed', supportedSources: SOURCES, unsupportedSources: [], omissions: [], ...extra });
  const envelope = (command, extra = {}) => ({ envelopeVersion: 1, packVersion: PACK_VERSION, ok: true, command, context, cliVersion, transfers, coverage: coverage({}), continuation: null, ...extra });
  const token = (type, data) => Buffer.from(JSON.stringify({ v: 1, type, context: contextHash, ...data })).toString('base64url');
  function untoken(value, type) {
    if (typeof value !== 'string' || !value || bytes(value) > 30000 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_INPUT');
    let data; try { data = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { fail('INVALID_INPUT'); }
    if (!object(data) || data.v !== 1 || data.type !== type) fail('INVALID_INPUT');
    if (data.context !== contextHash) fail('CONTEXT_MISMATCH');
    return data;
  }
  const reference = row => token('reference', { id: row.id, source: row.source, sourceId: row.source_id });
  const displayValue = value => typeof value === 'string' ? value.slice(0, 160) : null;
  const provenanceValue = value => typeof value === 'string' ? value : null;
  async function display(row, provenance) {
    const voice = row.source === 'exo-voice-note'
      ? provenance ?? (await voiceNoteBodyKey(row, true)).transcriptProvenance
      : { engine: null, provider: null, model: null };
    return { id: row.id, ref: reference(row), source: row.source, sourceId: row.source_id, title: row.title, startedAt: row.started_at, organizerEmail: row.organizer_email, participants: row.participants, storedSummary: row.summary_overview, contentKind: row.contentKind, engine: displayValue(voice.engine), provider: displayValue(voice.provider), model: displayValue(voice.model), metadataMayBeTruncated: true, revision: null, readiness: 'unknown' };
  }
  async function authorize() {
    const status = parse(await run(['auth', 'status']));
    if (status?.authenticated !== true) fail('AUTH_REQUIRED');
    const actual = status.ownerDid ?? status.did;
    if (typeof actual !== 'string' || actual.toLowerCase() !== context.owner) fail('OWNER_MISMATCH');
    if (status.profile !== context.profile || typeof status.host !== 'string' || status.host.replace(/\/$/, '') !== context.host) fail('CONTEXT_MISMATCH');
  }
  async function query(sql, params) { return rows(await run(['sql', 'query', sql, '--db', DATABASE, '--space', context.space, '--params', JSON.stringify(params)])); }
  async function page(scope, after, count, bodySearch = false, supportedOnly = false, transcriptOnly = false, commitTableAvailable = false) { const q = makeQuery(scope, after, count, bodySearch, supportedOnly, transcriptOnly, commitTableAvailable); return query(q.sql, q.params); }
  async function voiceNoteCommitTableAvailable() {
    const schema = parse(await run(['sql', 'query', "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'voice_note_transcript'", '--db', DATABASE, '--space', context.space]));
    if (!Array.isArray(schema?.columns) || schema.columns.join(',') !== 'name' || !Array.isArray(schema.rows) || schema.rows.some(row => !Array.isArray(row) || row.length !== 1) || schema.rows.length > 1) fail('INVALID_RESPONSE');
    return schema.rows.length === 1;
  }
  async function exact(ref) {
    const selected = untoken(ref, 'reference');
    if (!safeId(selected.id) || !safeSegment(selected.sourceId) || !SOURCES.includes(selected.source)) fail('INVALID_INPUT');
    const result = await query(`SELECT ${PROJECTION} FROM connector_meeting WHERE id = ? LIMIT 2`, [selected.id]);
    if (!result.length) fail('MEETING_NOT_FOUND');
    if (result.length !== 1 || result[0].id !== selected.id) fail('INVALID_RESPONSE');
    const row = metadata(result[0]);
    if (row.source !== selected.source || row.source_id !== selected.sourceId) fail('SOURCE_CHANGED');
    return row;
  }
  async function privateDirectory(path) {
    const info = await lstat(path).catch(() => fail('ACQUISITION_INVALID'));
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()) fail('ACQUISITION_INVALID');
  }
  async function privateFile(path, limit) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail('ACQUISITION_INVALID'));
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid() || info.nlink !== 1 || info.size > limit) fail('ACQUISITION_INVALID');
      const data = await file.readFile();
      if (data.length > limit) fail('ACQUISITION_INVALID');
      return data;
    } finally { await file.close(); }
  }
  async function reserveAcquisition() {
    await privateDirectory(dirname(acquisitionDir));
    try { await mkdir(acquisitionDir, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') fail('ACQUISITION_EXISTS'); fail('ACQUISITION_INVALID'); }
    createdAcquisition = true;
    await privateDirectory(acquisitionDir);
  }
  function normalizedTranscriptText(text) { return text.replace(/\s+/gu, ' ').trim(); }
  function normalizedTranscript(spans) { return normalizedTranscriptText(spans.map(span => span.text).join(' ')); }
  function transcriptTextSha256(text) { return digest(Buffer.from(normalizedTranscriptText(text), 'utf8')); }
  function decoded(data, row, kvKey, bodyOrigin = 'kv', legacyWinner = null) {
    let raw; try { raw = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { fail('UNSUPPORTED_FORMAT'); }
    const spans = decodeBody(raw, row.source);
    const sourceLocation = bodyOrigin === 'legacy-metadata'
      ? { database: DATABASE, table: 'connector_meeting', id: legacyWinner.id, metadataField: 'transcript_text' }
      : { database: DATABASE, table: 'connector_meeting', id: row.id, kvKey };
    const provenance = { contentKind: row.contentKind, sourceLocation, bodyOrigin, ...(legacyWinner ? { legacyWinner: { id: legacyWinner.id, transcribedAt: legacyWinner.transcribedAt } } : {}), revision: null, metadataUpdatedAt: row.updated_at, bodySha256: digest(data), hashMeaning: bodyOrigin === 'legacy-metadata' ? 'SHA-256 of the local JSON encoding of validated legacy metadata transcript text' : 'SHA-256 of this fetched legacy body only', atomicSnapshot: false, captureComplete: null, originalBytes: data.length, originalRecords: spans.length, offsetUnit: 'UTF-16 within original record text' };
    return { spans, provenance, ...(legacyWinner ? { legacyWinner } : {}) };
  }
  async function transcriptTextBytes(row, expectedText, retained, file, legacyWinner) {
    if (typeof expectedText !== 'string' || !expectedText.trim()) omitTranscript(row, 'not_transcribed');
    const data = Buffer.from(JSON.stringify([{ text: expectedText }]), 'utf8');
    if (data.length > bodyBytes) fail('OUTPUT_LIMIT');
    const evidence = decoded(data, row, undefined, 'legacy-metadata', legacyWinner);
    if (retained) await writeFile(file, data, { mode: 0o600 });
    return evidence;
  }
  async function voiceNoteBodyKey(row, metadataOnly = false) {
    const legacyKey = `${DATABASE}/${row.source}/transcript/${row.source_id}`;
    if (await voiceNoteCommitTableAvailable()) {
      const committed = parse(await run(['sql', 'query', 'SELECT body_key, outcome, engine, provider, model FROM voice_note_transcript WHERE source_id = ? LIMIT 2', '--db', DATABASE, '--space', context.space, '--params', JSON.stringify([row.source_id])]));
      if (!Array.isArray(committed?.columns) || committed.columns.join(',') !== 'body_key,outcome,engine,provider,model' || !Array.isArray(committed.rows) || committed.rows.some(r => !Array.isArray(r) || r.length !== 5) || committed.rows.length > 1) fail('INVALID_RESPONSE');
      if (committed.rows.length) {
        const [key, outcome, engine, provider, model] = committed.rows[0];
        const transcriptProvenance = { engine: provenanceValue(engine), provider: provenanceValue(provider), model: provenanceValue(model) };
        if (metadataOnly) return { transcriptProvenance };
        if (outcome === 'no_speech') omitTranscript(row, 'no_speech');
        if (outcome !== 'transcribed' || typeof key !== 'string') fail('INVALID_METADATA');
        const prefix = `${DATABASE}/${row.source}/transcript-rev/${row.source_id}/`;
        if (!key.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(key.slice(prefix.length))) fail('INVALID_METADATA');
        return { key, expectedText: null, legacy: false, legacyWinner: null, transcriptProvenance };
      }
    }
    const winner = parse(await run([
      'sql', 'query',
      `SELECT g.id, g.metadata FROM connector_meeting g WHERE g.source_id = ? AND ${LEGACY_WINNER_FILTER_SQL} ${LEGACY_WINNER_ORDER_SQL}`,
      '--db', DATABASE, '--space', context.space, '--params', JSON.stringify([row.source_id]),
    ]));
    if (!Array.isArray(winner?.columns) || winner.columns.join(',') !== 'id,metadata' || !Array.isArray(winner.rows) || winner.rows.some(r => !Array.isArray(r) || r.length !== 2) || winner.rows.length > 1) fail('INVALID_RESPONSE');
    if (!winner.rows.length) {
      if (metadataOnly) return { transcriptProvenance: { engine: null, provider: null, model: null } };
      omitTranscript(row, 'not_transcribed');
    }
    const [winnerId, metadataJson] = winner.rows[0];
    if (!safeId(winnerId)) fail('INVALID_METADATA');
    let legacyMetadata;
    try { legacyMetadata = JSON.parse(metadataJson); } catch { fail('INVALID_METADATA'); }
    if (!object(legacyMetadata)) fail('INVALID_METADATA');
    const outcome = legacyMetadata.transcription_outcome;
    const transcriptProvenance = { engine: provenanceValue(legacyMetadata.transcription_engine), provider: provenanceValue(legacyMetadata.transcript_provider), model: provenanceValue(legacyMetadata.model) };
    if (metadataOnly) return { transcriptProvenance };
    if (outcome !== 'transcribed') {
      const device = legacyMetadata.device_transcript;
      const pendingDevice = outcome === 'pending' && legacyMetadata.transcript_location === 'device'
        && object(device) && device.state === 'done' && Number.isSafeInteger(device.rev) && device.rev > 0
        && typeof device.transcribed_at === 'string';
      omitTranscript(row, pendingDevice ? 'pending_device_sync'
        : outcome === 'no_speech' ? 'no_speech'
          : ['pending', 'failed', 'skipped'].includes(outcome) ? outcome : 'not_transcribed');
    }
    const expectedText = legacyMetadata.transcript_text;
    if (typeof expectedText !== 'string' || !expectedText.trim()) omitTranscript(row, 'not_transcribed');
    const legacyWinner = {
      id: winnerId,
      outcome,
      transcribedAt: typeof legacyMetadata.transcribed_at === 'string' ? legacyMetadata.transcribed_at : null,
      transcriptText: expectedText,
      transcriptTextSha256: transcriptTextSha256(expectedText),
    };
    return { key: legacyKey, expectedText, legacy: true, legacyWinner, transcriptProvenance };
  }
  async function body(row, expectedHash, retained = false) {
    const resolved = row.source === 'exo-voice-note'
      ? await voiceNoteBodyKey(row)
      : { key: `${DATABASE}/${row.source}/transcript/${row.source_id}`, expectedText: null, legacy: false, legacyWinner: null, transcriptProvenance: { engine: null, provider: null, model: null } };
    const { key, expectedText, legacy, legacyWinner } = resolved;
    const directory = retained ? acquisitionDir : await mkdtemp(join(tmpdir(), 'tinychat-read-'));
    const file = join(directory, 'body');
    let attempted = false, observedBytes, evidence;
    try {
      await chmod(directory, 0o700);
      await writeFile(file, '', { flag: 'wx', mode: 0o600 });
      attempted = true; transfers.remoteBodyAcquisitions++;
      try { await run(['kv', 'get', key, '--space', context.space, '--output', file], { outputFile: file, maxOutputBytes: bodyBytes }); }
      catch (error) {
        observedBytes = await lstat(file).then(info => info.isFile() ? info.size : 0).catch(() => 0);
        const e = classified(error);
        if (legacy && e.code === 'MISSING_BODY') evidence = await transcriptTextBytes(row, expectedText, retained, file, legacyWinner);
        else throw e;
      }
      if (!evidence) {
        const size = (await stat(file)).size;
        observedBytes = size;
        if (size > bodyBytes) fail('OUTPUT_LIMIT');
        const data = retained ? await privateFile(file, bodyBytes) : await readFile(file);
        if (legacy) {
          let mirror;
          try { mirror = decoded(data, row, key, 'kv', legacyWinner); }
          catch (error) { if (!['UNSUPPORTED_FORMAT', 'EMPTY_BODY'].includes(error.code)) throw error; }
          evidence = mirror && normalizedTranscript(mirror.spans) === normalizedTranscriptText(expectedText)
            ? mirror
            : await transcriptTextBytes(row, expectedText, retained, file, legacyWinner);
        } else evidence = decoded(data, row, key);
      }
      if (expectedHash !== undefined && evidence.provenance.bodySha256 !== expectedHash) fail('REVISION_CHANGED');
      return { ...evidence, transcriptProvenance: resolved.transcriptProvenance };
    } finally {
      if (attempted) transfers.remoteBodyBytes += observedBytes ?? await lstat(file).then(info => info.isFile() ? info.size : 0).catch(() => 0);
      if (!retained) await rm(directory, { recursive: true, force: true });
    }
  }
  async function acquire(ref) {
    const row = await exact(ref); readAccess.sqlRead = true;
    const data = await body(row, undefined, true); readAccess.bodyRead = true; readAccess.currentAuthorityVerified = true; readAccess.currentBodyRevisionVerified = true;
    const acquiredAt = new Date().toISOString();
    const manifest = { v: 1, context, contextHash, binding: acquisitionBinding, ref, row, acquiredAt, transcriptProvenance: data.transcriptProvenance, ...(data.provenance.bodyOrigin === 'legacy-metadata' ? { bodyOrigin: 'legacy-metadata' } : { kvKey: data.provenance.sourceLocation.kvKey }), ...(data.legacyWinner ? { legacyWinner: data.legacyWinner } : {}), bodySha256: data.provenance.bodySha256 };
    const raw = JSON.stringify(manifest), manifestLimit = 128 * 1024 + 2 * bodyBytes;
    if (bytes(raw) > manifestLimit) fail('OUTPUT_LIMIT');
    await writeFile(join(acquisitionDir, 'manifest.json'), raw, { flag: 'wx', mode: 0o600 });
    return { row, data, acquisition: { mode: 'remote-acquisition', binding: acquisitionBinding, acquiredAt, manifestSha256: digest(raw) } };
  }
  async function historical(state) {
    if (!object(state.acquisition) || state.acquisition.binding !== acquisitionBinding || !/^[a-f0-9]{64}$/.test(state.acquisition.manifestSha256)) fail('ACQUISITION_INVALID');
    await privateDirectory(dirname(acquisitionDir)); await privateDirectory(acquisitionDir);
    const raw = await privateFile(join(acquisitionDir, 'manifest.json'), 128 * 1024 + 2 * bodyBytes);
    if (digest(raw) !== state.acquisition.manifestSha256) fail('ACQUISITION_INVALID');
    let manifest; try { manifest = JSON.parse(raw); } catch { fail('ACQUISITION_INVALID'); }
    if (!object(manifest) || manifest.v !== 1 || manifest.contextHash !== contextHash || JSON.stringify(manifest.context) !== JSON.stringify(context) || manifest.binding !== acquisitionBinding || manifest.ref !== state.ref || manifest.bodySha256 !== state.hash || !timestamp(manifest.acquiredAt)) fail('ACQUISITION_INVALID');
    const row = metadata(manifest.row);
    if (reference(row) !== state.ref) fail('ACQUISITION_INVALID');
    const rawBody = await privateFile(join(acquisitionDir, 'body'), bodyBytes);
    if (digest(rawBody) !== manifest.bodySha256) fail('ACQUISITION_INVALID');
    const bodyOrigin = manifest.bodyOrigin ?? 'kv';
    const legacyWinner = manifest.legacyWinner ?? null;
    if (legacyWinner !== null && (!object(legacyWinner) || row.source !== 'exo-voice-note' || !safeId(legacyWinner.id) || legacyWinner.outcome !== 'transcribed' || typeof legacyWinner.transcribedAt !== 'string' && legacyWinner.transcribedAt !== null || typeof legacyWinner.transcriptText !== 'string' || !legacyWinner.transcriptText.trim() || !/^[a-f0-9]{64}$/.test(legacyWinner.transcriptTextSha256) || transcriptTextSha256(legacyWinner.transcriptText) !== legacyWinner.transcriptTextSha256)) fail('ACQUISITION_INVALID');
    if (bodyOrigin === 'legacy-metadata') {
      if (!legacyWinner || manifest.kvKey !== undefined) fail('ACQUISITION_INVALID');
    } else if (bodyOrigin !== 'kv' || (legacyWinner && row.source !== 'exo-voice-note')) fail('ACQUISITION_INVALID');
    const legacyKey = `${DATABASE}/${row.source}/transcript/${row.source_id}`;
    const kvKey = bodyOrigin === 'legacy-metadata' ? undefined : manifest.kvKey ?? legacyKey;
    const revisionPrefix = `${DATABASE}/exo-voice-note/transcript-rev/${row.source_id}/`;
    if (legacyWinner && bodyOrigin === 'kv' && kvKey !== legacyKey) fail('ACQUISITION_INVALID');
    if (bodyOrigin === 'kv' && kvKey !== legacyKey && (row.source !== 'exo-voice-note' || typeof kvKey !== 'string' || !kvKey.startsWith(revisionPrefix) || !/^[a-f0-9]{32}$/.test(kvKey.slice(revisionPrefix.length)))) fail('ACQUISITION_INVALID');
    const transcriptProvenance = object(manifest.transcriptProvenance) ? manifest.transcriptProvenance : { engine: null, provider: null, model: null };
    if (Object.keys(transcriptProvenance).some(key => !['engine', 'provider', 'model'].includes(key)) || ['engine', 'provider', 'model'].some(key => transcriptProvenance[key] !== null && typeof transcriptProvenance[key] !== 'string')) fail('ACQUISITION_INVALID');
    const data = { ...decoded(rawBody, row, kvKey, bodyOrigin, legacyWinner), transcriptProvenance };
    if (legacyWinner && normalizedTranscript(data.spans) !== normalizedTranscriptText(legacyWinner.transcriptText)) fail('ACQUISITION_INVALID');
    if (bodyOrigin === 'legacy-metadata' && (data.spans.length !== 1 || data.spans[0].text !== legacyWinner.transcriptText)) fail('ACQUISITION_INVALID');
    return { row, data, acquisition: { mode: 'local-historical', binding: acquisitionBinding, acquiredAt: manifest.acquiredAt, manifestSha256: state.acquisition.manifestSha256 } };
  }
  function finish(result) { if (bytes(result) > envelopeBytes) fail('OUTPUT_LIMIT'); return result; }
  async function find(input) {
    keys(input, ['term', 'source', 'from', 'to', 'limit', 'cursor']);
    let scope, after = null, examined = 0;
    if (input.cursor) { if (Object.keys(input).length !== 1) fail('INVALID_INPUT'); const state = untoken(input.cursor, 'find'); scope = filters(state.scope); after = state.after; examined = state.examined; validateAfter(after); if (!integer(examined, 0, 100000000)) fail('INVALID_INPUT'); }
    else scope = filters(input);
    const all = await page(scope, after, 51);
    const result = envelope('find', { records: [], coverage: coverage({ searchScope: 'metadata', examinedRecords: examined, catalogRecordsExamined: examined, completeWithinScope: false, unexaminedRecords: 'unknown', discoveryConsistency: 'keyset over observed catalog; concurrent updates may change scope' }) });
    const unsupported = new Set();
    let consumed = 0, nextAfter = after, lastIndex = -1;
    for (let i = 0; i < all.length && result.records.length < scope.limit; i++) {
      const raw = all[i];
      let row;
      try { row = metadata(raw); }
      catch (error) {
        if (classified(error).code !== 'UNSUPPORTED_SOURCE') throw error;
        unsupported.add(raw.source);
        result.coverage.omissions.push({ id: raw.id, source: raw.source, started_at: raw.started_at });
        consumed++; nextAfter = position(raw); lastIndex = i;
        continue;
      }
      const next = position(row);
      const record = await display(row);
      const candidate = { ...result, records: [...result.records, record], continuation: token('find', { scope, after: next, examined: examined + consumed + 1 }) };
      if (bytes(candidate) > envelopeBytes - 250) { if (!result.records.length) fail('OUTPUT_LIMIT'); break; }
      result.records.push(record);
      consumed++; nextAfter = next; lastIndex = i;
    }
    result.coverage.unsupportedSources = [...unsupported];
    result.coverage.examinedRecords = result.coverage.catalogRecordsExamined = examined + consumed;
    const more = lastIndex >= 0 && (lastIndex < all.length - 1 || all.length === 51);
    result.continuation = more ? token('find', { scope, after: nextAfter, examined: examined + consumed }) : null;
    result.coverage.completeWithinScope = !more;
    result.coverage.unexaminedRecords = more ? 'unknown' : 0;
    return finish(result);
  }
  async function latest(input) {
    keys(input, ['source', 'from', 'to']);
    const scope = filters(input), all = await page(scope, null, 51);
    const commitTableAvailable = await voiceNoteCommitTableAvailable();
    const supported = await page(scope, null, 2, false, true, true, commitTableAvailable);
    const unsupported = new Set(), omissions = [];
    for (const raw of all) {
      try { metadata(raw); }
      catch (error) {
        if (classified(error).code !== 'UNSUPPORTED_SOURCE') throw error;
        unsupported.add(raw.source);
        omissions.push({ id: raw.id, source: raw.source, started_at: raw.started_at });
      }
    }
    const selectedRows = supported.map(metadata);
    const row = selectedRows[0] ?? null, secondSupported = selectedRows[1] ?? null;
    const selected = row !== null && row.sort_time !== null;
    const status = !row ? 'empty' : selected ? 'selected' : 'no-dated-meeting';
    return finish(envelope('latest', {
      records: selected ? [await display(row)] : [],
      selection: { intent: 'latest', resolved: selected, status, reason: selected ? 'Newest supported dated transcript-eligible catalog record selected. Read this reference; older catalog pages are unnecessary.' : row ? 'No supported transcript-eligible meeting has a usable start date; latest cannot be established.' : 'No transcript-eligible supported meeting exists within these filters.', ordering: 'startedAt instant descending; undated last; id ascending', tieBreak: 'id-ascending', tiedAtNewest: selected && secondSupported?.sort_time === row.sort_time, nextAction: selected ? 'read' : null },
      coverage: coverage({ searchScope: 'metadata', unsupportedSources: [...unsupported], omissions, examinedRecords: all.length, catalogRecordsExamined: all.length, moreCatalogRecords: all.length === 51, completeWithinScope: all.length < 51, unexaminedRecords: all.length === 51 ? 'unknown' : 0, discoveryConsistency: 'bounded observation of catalog order; concurrent changes may alter latest' }),
    }));
  }
  async function read(input) {
    keys(input, ['ref', 'cursor']); if (Boolean(input.ref) === Boolean(input.cursor)) fail('INVALID_INPUT');
    const state = input.cursor ? untoken(input.cursor, 'read') : { ref: input.ref, recordIndex: 0, offset: 0 };
    if (!integer(state.recordIndex, 0, 10000000) || !integer(state.offset, 0, 64000000) || (state.hash !== undefined && !/^[a-f0-9]{64}$/.test(state.hash))) fail('INVALID_INPUT');
    let row, data, acquisition;
    if (acquisitionDir) {
      ({ row, data, acquisition } = input.cursor ? await historical(state) : await acquire(state.ref));
      data.provenance.evidenceSemantics = acquisition.mode === 'local-historical' ? 'historical acquisition; current remote authority, source and body revision unobserved' : 'verified remote acquisition; later local pages are historical evidence';
      data.provenance.acquiredAt = acquisition.acquiredAt;
    } else {
      if (state.acquisition) fail('ACQUISITION_INVALID');
      row = await exact(state.ref); readAccess.sqlRead = true;
      data = await body(row, state.hash); readAccess.bodyRead = true; readAccess.currentAuthorityVerified = true; readAccess.currentBodyRevisionVerified = true;
    }
    if (state.recordIndex >= data.spans.length || state.offset > data.spans[state.recordIndex].text.length || boundary(data.spans[state.recordIndex].text, state.offset) !== state.offset) fail('INVALID_INPUT');
    let recordIndex = state.recordIndex, offset = state.offset;
    const result = envelope('read', { access: readAccess, ...(acquisition ? { acquisition } : {}), record: await display(row, data.transcriptProvenance), provenance: data.provenance, spans: [], coverage: coverage({ searchScope: 'exact-body', fullArtifactDecoded: true, totalRecords: data.spans.length, returnedRecords: 0, pageStartsAt: { recordIndex, offset }, completeWithinScope: false }) });
    const makeCursor = (i, at) => i < data.spans.length ? token('read', { ref: state.ref, hash: data.provenance.bodySha256, recordIndex: i, offset: at, ...(acquisition ? { acquisition: { binding: acquisition.binding, manifestSha256: acquisition.manifestSha256 } } : {}) }) : null;
    while (recordIndex < data.spans.length) {
      const original = data.spans[recordIndex];
      const left = original.text.length - offset;
      let low = 0, high = left, best = -1;
      // Measure the complete serialized envelope including every reference and cursor.
      while (low <= high) {
        const n = Math.floor((low + high) / 2), end = boundary(original.text, offset + n);
        const piece = { ...original, text: original.text.slice(offset, end), start: offset, end };
        const nextI = end === original.text.length ? recordIndex + 1 : recordIndex, nextAt = end === original.text.length ? 0 : end;
        const candidate = { ...result, spans: [...result.spans, piece], continuation: makeCursor(nextI, nextAt) };
        if (bytes(candidate) <= envelopeBytes - 200) { best = end; low = n + 1; } else high = n - 1;
      }
      if (best < offset || (best === offset && left > 0)) { if (!result.spans.length) fail('OUTPUT_LIMIT'); break; }
      result.spans.push({ ...original, text: original.text.slice(offset, best), start: offset, end: best });
      if (best < original.text.length) { offset = best; break; }
      recordIndex++; offset = 0;
    }
    result.continuation = makeCursor(recordIndex, offset);
    result.coverage.returnedRecords = result.spans.length;
    result.coverage.completeWithinScope = state.recordIndex === 0 && state.offset === 0 && result.continuation === null;
    result.coverage.traversalReachedEnd = result.continuation === null;
    result.coverage.nextPosition = result.continuation ? { recordIndex, offset } : null;
    return finish(result);
  }
  async function search(input) {
    keys(input, ['term', 'source', 'from', 'to', 'limit', 'scanLimit', 'cursor']);
    let state;
    if (input.cursor) { if (Object.keys(input).length !== 1) fail('INVALID_INPUT'); state = untoken(input.cursor, 'search'); }
    else state = { scope: filters(input, true), after: null, catalogRecordsExamined: 0, failedBodies: 0, excludedBodies: 0, matchesReturned: 0, pending: null, unsupportedSources: [] };
    state.scope = filters(state.scope, true); validateAfter(state.after);
    if (!Array.isArray(state.unsupportedSources) || state.unsupportedSources.some(source => !safeId(source))) fail('INVALID_INPUT');
    for (const k of ['catalogRecordsExamined', 'failedBodies', 'excludedBodies', 'matchesReturned']) if (!integer(state[k], 0, 100000000)) fail('INVALID_INPUT');
    if (state.pending !== null && (!object(state.pending) || !integer(state.pending.recordIndex, 0, 10000000) || !integer(state.pending.offset, 0, 64000000) || !/^[a-f0-9]{64}$/.test(state.pending.hash))) fail('INVALID_INPUT');
    if (state.failedBodies + state.excludedBodies > state.catalogRecordsExamined) fail('INVALID_INPUT');
    const counts = () => ({ catalogRecordsExamined: state.catalogRecordsExamined, bodiesExamined: state.catalogRecordsExamined - state.failedBodies - state.excludedBodies, failedBodies: state.failedBodies, excludedBodies: state.excludedBodies });
    const result = envelope('search', { matches: [], omissions: [], coverage: coverage({ searchScope: 'transcript-content', contentKinds: ['transcript'], matching: 'literal case-insensitive passages', ...counts(), matchingPassagesReturned: state.matchesReturned, unexaminedBodies: 'unknown', completeWithinScope: false, unsupportedSources: [...state.unsupportedSources] }) });
    let scanned = 0, exhausted = false;
    const pattern = new RegExp(state.scope.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const continuation = () => token('search', { scope: state.scope, after: state.after, catalogRecordsExamined: state.catalogRecordsExamined, failedBodies: state.failedBodies, excludedBodies: state.excludedBodies, matchesReturned: state.matchesReturned, pending: state.pending, unsupportedSources: state.unsupportedSources });
    const addOmission = omission => {
      if (bytes({ ...result, omissions: [...result.omissions, omission], continuation: continuation() }) <= envelopeBytes - 500) result.omissions.push(omission);
      else result.omissionDetailsLimited = true;
    };
    while (scanned < state.scope.scanLimit) {
      let next;
      try { next = state.pending ? [await exact(state.pending.ref)] : await page(state.scope, state.after, 1, true); }
      catch (error) {
        // No catalog position was consumed; Continue can retry without losing earlier matches.
        addOmission({ code: classified(error).code, stage: 'catalog' });
        break;
      }
      if (!next.length) { exhausted = true; break; }
      let row;
      try { row = metadata(next[0]); }
      catch (error) {
        const e = classified(error);
        try { validateAfter(position(next[0])); } catch { addOmission({ code: 'INVALID_METADATA', stage: 'catalog' }); break; }
        state.after = position(next[0]); state.pending = null; state.failedBodies++; state.catalogRecordsExamined++; scanned++;
        if (e.code === 'UNSUPPORTED_SOURCE') {
          if (!state.unsupportedSources.includes(next[0].source)) state.unsupportedSources.push(next[0].source);
          addOmission({ code: e.code, stage: 'metadata', id: next[0].id, source: next[0].source, started_at: next[0].started_at });
        } else addOmission({ code: e.code, stage: 'metadata' });
        continue;
      }
      const rowRef = reference(row);
      // Reserve the next keyset before consuming a long identity. A new response can then
      // continue it without sacrificing matches already supplied on this response.
      const priorAfter = state.after, priorPending = state.pending;
      state.after = position(row); state.pending = null;
      const nextPositionFits = bytes({ ...result, continuation: continuation() }) <= envelopeBytes - 500;
      state.after = priorAfter; state.pending = priorPending;
      if (!nextPositionFits) { if (!result.matches.length && !result.omissions.length) fail('OUTPUT_LIMIT'); break; }
      if (row.contentKind !== 'transcript') {
        state.excludedBodies++; state.catalogRecordsExamined++; scanned++; state.after = position(row); state.pending = null;
        addOmission({ ref: rowRef, code: 'GENERATED_NOTES_EXCLUDED' });
        continue;
      }
      let data;
      try { data = await body(row, state.pending?.hash); }
      catch (error) {
        const e = classified(error);
        if (state.pending && e.code === 'REVISION_CHANGED') throw e;
        if (e.code === 'TRANSCRIPT_OMITTED') {
          state.excludedBodies++; state.catalogRecordsExamined++; scanned++; state.after = position(row); state.pending = null;
          addOmission({ ref: rowRef, code: e.code, reason: e.reason, id: row.id, source: row.source, started_at: row.started_at });
          continue;
        }
        state.failedBodies++; state.catalogRecordsExamined++; scanned++; state.after = position(row); state.pending = null;
        addOmission({ ref: rowRef, code: e.code });
        if (['AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_OR_PERMISSION', 'PERMISSION_DENIED', 'SPACE_NOT_HOSTED', 'NETWORK_ERROR', 'TIMEOUT', 'CANCELLED'].includes(e.code)) break;
        continue;
      }
      let index = state.pending?.recordIndex ?? 0, offset = state.pending?.offset ?? 0;
      if (index >= data.spans.length || offset > data.spans[index].text.length) fail('INVALID_INPUT');
      let stopped = false;
      for (; index < data.spans.length; index++, offset = 0) {
        const span = data.spans[index]; pattern.lastIndex = offset; let match;
        while ((match = pattern.exec(span.text)) !== null) {
          const start = boundary(span.text, Math.max(0, match.index - 160)), end = boundary(span.text, Math.min(span.text.length, match.index + match[0].length + 160));
          const item = { record: await display(row, data.transcriptProvenance), provenance: data.provenance, span: { ...span, text: span.text.slice(start, end), start, end, matchStart: match.index, matchEnd: match.index + match[0].length } };
          state.pending = { ref: rowRef, hash: data.provenance.bodySha256, recordIndex: index, offset: match.index };
          const candidate = { ...result, matches: [...result.matches, item], continuation: continuation() };
          if (result.matches.length >= state.scope.limit || bytes(candidate) > envelopeBytes - 1000) { if (!result.matches.length && !result.omissions.length) fail('OUTPUT_LIMIT'); stopped = true; break; }
          result.matches.push(item); state.matchesReturned++; offset = pattern.lastIndex;
          state.pending.offset = offset;
        }
        if (stopped) break;
      }
      if (stopped) break;
      state.after = position(row); state.pending = null; state.catalogRecordsExamined++; scanned++;
    }
    result.continuation = exhausted ? null : continuation();
    Object.assign(result.coverage, { ...counts(), matchingPassagesReturned: state.matchesReturned, unexaminedBodies: exhausted ? state.failedBodies : 'unknown', pendingBody: state.pending !== null, completeWithinScope: exhausted && state.failedBodies === 0, unsupportedSources: [...state.unsupportedSources], omissions: result.omissions.filter(item => item.id && item.source).map(({ id, source, started_at, reason }) => ({ id, source, started_at, ...(reason ? { reason } : {}) })) });
    return finish(result);
  }
  async function checkVersion() {
    const version = String(await run(['--version'])).trim().replace(/^(?:tc\s+)/, '');
    const comparison = compareSemver(version, PACK.cli.minimumVersion);
    if (Number.isNaN(comparison) || comparison < 0) fail('CLI_VERSION');
    cliVersion = version;
  }
  async function diagnostics() {
    const r = envelope('diagnostics', { cliVersion, coverage: coverage({ supportedSources: SOURCES }), access: { authenticated: true, sqlRead: false, bodyRead: null } });
    try {
      const found = await page({}, null, 1, false, true); r.access.sqlRead = true;
      if (found.length) { r.access.bodyRead = false; await body(metadata(found[0])); r.access.bodyRead = true; }
      else r.bodyReadReason = 'No supported catalog record available for a body-read probe.';
    } catch (error) {
      const e = classified(error); r.ok = false; r.error = { code: e.code, message: e.message };
    }
    return finish(r);
  }
  return {
    async invoke(command, input = {}) {
      transfers = { remoteBodyAcquisitions: 0, remoteBodyBytes: 0, countMeaning: 'Transcript-body KV get attempts; bytes observed in body output files' };
      readAccess = { authenticated: false, sqlRead: false, bodyRead: false, currentAuthorityVerified: false, currentBodyRevisionVerified: false };
      createdAcquisition = false;
      backendPending = {
        'backend-ingest': unknownPending(null),
        transcriber: unknownPending(null),
      };
      try {
        validateContext(); if (!['diagnostics', 'find', 'latest', 'read', 'search'].includes(command)) fail('INVALID_INPUT');
        if (acquisitionDir && command === 'read' && !input.cursor) {
          keys(input, ['ref', 'cursor']); if (!input.ref) fail('INVALID_INPUT');
          untoken(input.ref, 'reference');
          await reserveAcquisition();
        }
        if (!(acquisitionDir && command === 'read' && input.cursor)) {
          await checkVersion();
          await authorize();
          readAccess.authenticated = true;
          backendPending = await readBackendPending();
        }
        if (command === 'diagnostics') { keys(input, []); return await diagnostics(); }
        return await ({ find, latest, read, search })[command](input);
      } catch (error) {
        const e = classified(error);
        if (createdAcquisition) {
          await writeFile(join(acquisitionDir, 'failure.json'), JSON.stringify({ error: { code: e.code }, contextHash, binding: acquisitionBinding, failedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }).catch(() => {});
        }
        return { transfers, ...(command === 'read' ? { access: readAccess } : {}), envelopeVersion: 1, packVersion: PACK_VERSION, ok: false, command: ['diagnostics', 'find', 'latest', 'read', 'search'].includes(command) ? command : null, coverage: coverage({ completeWithinScope: false, omissions: e.omission ? [e.omission] : [] }), continuation: null, error: { code: e.code, message: e.message, ...(e.reason ? { reason: e.reason } : {}) } };
      }
    },
  };
}
