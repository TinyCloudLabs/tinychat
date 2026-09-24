import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, chmod, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PACK_VERSION = '0.1.0';
export const DATABASE = 'xyz.tinycloud.tinychat/connectors';
const SOURCES = ['fireflies', 'google-meet', 'tinycloud-transcriber'];
const COLUMNS = ['id', 'source', 'source_id', 'title', 'started_at', 'organizer_email', 'participants', 'summary_overview', 'summary_action_items', 'metadata', 'updated_at', 'sort_time'];
// Limit display-only fields at the query boundary; identity and classification fields stay exact.
const PROJECTION = COLUMNS.map(c => ['title', 'organizer_email', 'participants', 'summary_overview', 'summary_action_items'].includes(c) ? `substr(${c},1,600) AS ${c}` : c === 'sort_time' ? 'julianday(started_at) AS sort_time' : c).join(', ');
const MESSAGES = {
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
  constructor(code) { super(MESSAGES[code] ?? MESSAGES.CLI_ERROR); this.code = code; }
}
const fail = code => { throw new RetrievalError(code); };
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
function makeQuery(scope, after, limit, bodySearch = false) {
  const terms = [], params = [];
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
  if (!SOURCES.includes(row.source)) fail('UNSUPPORTED_SOURCE');
  for (const c of COLUMNS.slice(3, -1)) if (row[c] !== null && typeof row[c] !== 'string') fail('INVALID_METADATA');
  let extra; try { extra = row.metadata === null ? {} : JSON.parse(row.metadata); } catch { fail('INVALID_METADATA'); }
  if (!object(extra)) fail('INVALID_METADATA');
  validateAfter({ id: row.id, time: row.sort_time });
  const kind = row.source === 'google-meet' && extra.notes_kind === 'gemini' && extra.notes_association !== 'conference' ? 'generated-notes' : 'transcript';
  return { ...row, extra, contentKind: kind };
}
const position = row => ({ id: row.id, time: row.sort_time });
// Offsets are UTF-16 in each original text record, never in speaker/timestamp decoration.
function decodeBody(raw) {
  let value; try { value = JSON.parse(raw); } catch { fail('UNSUPPORTED_FORMAT'); }
  const records = typeof value === 'string' ? [{ text: value }] : value;
  if (!Array.isArray(records) || records.some(r => !object(r) || typeof r.text !== 'string')) fail('UNSUPPORTED_FORMAT');
  if (!records.some(r => r.text.trim())) fail('EMPTY_BODY');
  return records.map((r, recordIndex) => {
    const speaker = [r.speaker_name, r.speaker, r.speakerName].find(v => typeof v === 'string' && v.trim());
    const startSecs = [r.start_time, r.startTime, r.start].find(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
    return { text: r.text, recordIndex, start: 0, end: r.text.length, ...(speaker ? { speaker } : {}), ...(startSecs === undefined ? {} : { startSecs }) };
  });
}
function boundary(text, end) {
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end]) ? end - 1 : end;
}

export function createRetrieval({ profile, host, space, owner, tc, runTc = createTcRunner({ executable: tc }), bodyBytes = 8 * 1024 * 1024, envelopeBytes = 24000, signal } = {}) {
  let context, contextHash, cliVersion;
  function validateContext() {
    if (!safeSegment(profile) || typeof host !== 'string' || typeof owner !== 'string' || !/^did:pkh:eip155:[1-9][0-9]*:0x[a-fA-F0-9]{40}$/.test(owner) || typeof space !== 'string' || !space || bytes(space) > 1000 || !integer(bodyBytes, 1, 64 * 1024 * 1024) || !integer(envelopeBytes, 4000, 40000)) fail('INVALID_INPUT');
    let url; try { url = new URL(host); } catch { fail('INVALID_INPUT'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('INVALID_INPUT');
    const canonicalOwner = owner.toLowerCase();
    const uri = `tinycloud:${canonicalOwner.slice(4)}:${space}`;
    if (!/^[A-Za-z0-9_-]+$/.test(space) && !space.toLowerCase().startsWith(`tinycloud:${canonicalOwner.slice(4)}:`)) fail('CONTEXT_MISMATCH');
    context = { profile, host: url.origin, space: space.startsWith('tinycloud:') ? space : uri, owner: canonicalOwner };
    contextHash = digest(JSON.stringify(context));
  }
  const base = () => ['--profile', context.profile, '--host', context.host, '--json'];
  const run = (args, options = {}) => runTc([...base(), ...args], { signal, ...options });
  const coverage = extra => ({ catalog: 'connector_meeting SQL rows with legacy KV bodies', excludedCatalogs: ['user-kv-only', 'backend-only'], corpusComplete: false, scope: 'observed', ...extra });
  const envelope = (command, extra = {}) => ({ envelopeVersion: 1, packVersion: PACK_VERSION, ok: true, command, context, coverage: coverage({}), continuation: null, ...extra });
  const token = (type, data) => Buffer.from(JSON.stringify({ v: 1, type, context: contextHash, ...data })).toString('base64url');
  function untoken(value, type) {
    if (typeof value !== 'string' || !value || bytes(value) > 30000 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_INPUT');
    let data; try { data = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { fail('INVALID_INPUT'); }
    if (!object(data) || data.v !== 1 || data.type !== type) fail('INVALID_INPUT');
    if (data.context !== contextHash) fail('CONTEXT_MISMATCH');
    return data;
  }
  const reference = row => token('reference', { id: row.id, source: row.source, sourceId: row.source_id });
  const display = row => ({ id: row.id, ref: reference(row), source: row.source, sourceId: row.source_id, title: row.title, startedAt: row.started_at, organizerEmail: row.organizer_email, participants: row.participants, storedSummary: row.summary_overview, contentKind: row.contentKind, metadataMayBeTruncated: true, revision: null, readiness: 'unknown' });
  async function authorize() {
    const status = parse(await run(['auth', 'status']));
    if (status?.authenticated !== true) fail('AUTH_REQUIRED');
    const actual = status.ownerDid ?? status.did;
    if (typeof actual !== 'string' || actual.toLowerCase() !== context.owner) fail('OWNER_MISMATCH');
    if (status.profile !== context.profile || typeof status.host !== 'string' || status.host.replace(/\/$/, '') !== context.host) fail('CONTEXT_MISMATCH');
  }
  async function query(sql, params) { return rows(await run(['sql', 'query', sql, '--db', DATABASE, '--space', context.space, '--params', JSON.stringify(params)])); }
  async function page(scope, after, count, bodySearch = false) { const q = makeQuery(scope, after, count, bodySearch); return query(q.sql, q.params); }
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
  async function body(row, expectedHash) {
    const key = `${DATABASE}/${row.source}/transcript/${row.source_id}`;
    const directory = await mkdtemp(join(tmpdir(), 'tinychat-read-'));
    try {
      await chmod(directory, 0o700);
      const file = join(directory, 'body'); await writeFile(file, '', { flag: 'wx', mode: 0o600 });
      await run(['kv', 'get', key, '--space', context.space, '--output', file], { outputFile: file, maxOutputBytes: bodyBytes });
      if ((await stat(file)).size > bodyBytes) fail('OUTPUT_LIMIT');
      const data = await readFile(file);
      const hash = digest(data);
      if (expectedHash !== undefined && hash !== expectedHash) fail('REVISION_CHANGED');
      let raw; try { raw = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { fail('UNSUPPORTED_FORMAT'); }
      const spans = decodeBody(raw);
      return { spans, provenance: { contentKind: row.contentKind, sourceLocation: { database: DATABASE, table: 'connector_meeting', id: row.id, kvKey: key }, revision: null, metadataUpdatedAt: row.updated_at, bodySha256: hash, hashMeaning: 'SHA-256 of this fetched legacy body only', atomicSnapshot: false, captureComplete: null, originalBytes: data.length, originalRecords: spans.length, offsetUnit: 'UTF-16 within original record text' } };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  function finish(result) { if (bytes(result) > envelopeBytes) fail('OUTPUT_LIMIT'); return result; }
  async function find(input) {
    keys(input, ['term', 'source', 'from', 'to', 'limit', 'cursor']);
    let scope, after = null, examined = 0;
    if (input.cursor) { if (Object.keys(input).length !== 1) fail('INVALID_INPUT'); const state = untoken(input.cursor, 'find'); scope = filters(state.scope); after = state.after; examined = state.examined; validateAfter(after); if (!integer(examined, 0, 100000000)) fail('INVALID_INPUT'); }
    else scope = filters(input);
    const all = await page(scope, after, scope.limit + 1);
    const result = envelope('find', { records: [], coverage: coverage({ searchScope: 'metadata', examinedRecords: examined, completeWithinScope: false, unexaminedRecords: 'unknown', discoveryConsistency: 'keyset over observed catalog; concurrent updates may change scope' }) });
    for (let i = 0; i < Math.min(scope.limit, all.length); i++) {
      const row = metadata(all[i]);
      result.records.push(display(row));
      const next = position(row), more = i + 1 < all.length;
      const candidate = { ...result, continuation: more ? token('find', { scope, after: next, examined: examined + i + 1 }) : null };
      if (bytes(candidate) > envelopeBytes - 250) { result.records.pop(); if (!result.records.length) fail('OUTPUT_LIMIT'); break; }
      result.continuation = candidate.continuation; result.coverage.examinedRecords = examined + i + 1;
    }
    const complete = result.continuation === null;
    result.coverage.completeWithinScope = complete; result.coverage.unexaminedRecords = complete ? 0 : 'unknown';
    return finish(result);
  }
  async function read(input) {
    keys(input, ['ref', 'cursor']); if (Boolean(input.ref) === Boolean(input.cursor)) fail('INVALID_INPUT');
    const state = input.cursor ? untoken(input.cursor, 'read') : { ref: input.ref, recordIndex: 0, offset: 0 };
    if (!integer(state.recordIndex, 0, 10000000) || !integer(state.offset, 0, 64000000) || (state.hash !== undefined && !/^[a-f0-9]{64}$/.test(state.hash))) fail('INVALID_INPUT');
    const row = await exact(state.ref), data = await body(row, state.hash);
    if (state.recordIndex >= data.spans.length || state.offset > data.spans[state.recordIndex].text.length) fail('INVALID_INPUT');
    let recordIndex = state.recordIndex, offset = state.offset;
    const result = envelope('read', { record: display(row), provenance: data.provenance, spans: [], coverage: coverage({ searchScope: 'exact-body', fullArtifactDecoded: true, totalRecords: data.spans.length, returnedRecords: 0, pageStartsAt: { recordIndex, offset }, completeWithinScope: false }) });
    const makeCursor = (i, at) => i < data.spans.length ? token('read', { ref: state.ref, hash: data.provenance.bodySha256, recordIndex: i, offset: at }) : null;
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
    else state = { scope: filters(input, true), after: null, catalogRecordsExamined: 0, failedBodies: 0, excludedBodies: 0, matchesReturned: 0, pending: null };
    state.scope = filters(state.scope, true); validateAfter(state.after);
    for (const k of ['catalogRecordsExamined', 'failedBodies', 'excludedBodies', 'matchesReturned']) if (!integer(state[k], 0, 100000000)) fail('INVALID_INPUT');
    if (state.pending !== null && (!object(state.pending) || !integer(state.pending.recordIndex, 0, 10000000) || !integer(state.pending.offset, 0, 64000000) || !/^[a-f0-9]{64}$/.test(state.pending.hash))) fail('INVALID_INPUT');
    if (state.failedBodies + state.excludedBodies > state.catalogRecordsExamined) fail('INVALID_INPUT');
    const counts = () => ({ catalogRecordsExamined: state.catalogRecordsExamined, bodiesExamined: state.catalogRecordsExamined - state.failedBodies - state.excludedBodies, failedBodies: state.failedBodies, excludedBodies: state.excludedBodies });
    const result = envelope('search', { matches: [], omissions: [], coverage: coverage({ searchScope: 'transcript-content', contentKinds: ['transcript'], matching: 'literal case-insensitive passages', ...counts(), matchingPassagesReturned: state.matchesReturned, unexaminedBodies: 'unknown', completeWithinScope: false }) });
    let scanned = 0, exhausted = false;
    const pattern = new RegExp(state.scope.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const continuation = () => token('search', { scope: state.scope, after: state.after, catalogRecordsExamined: state.catalogRecordsExamined, failedBodies: state.failedBodies, excludedBodies: state.excludedBodies, matchesReturned: state.matchesReturned, pending: state.pending });
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
        // Keep the raw keyset position even when a source's body format is unsupported.
        try { validateAfter(position(next[0])); } catch { addOmission({ code: 'INVALID_METADATA', stage: 'catalog' }); break; }
        state.after = position(next[0]); state.pending = null; state.failedBodies++; state.catalogRecordsExamined++; scanned++;
        addOmission({ code: classified(error).code, stage: 'metadata' });
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
          const item = { record: display(row), provenance: data.provenance, span: { ...span, text: span.text.slice(start, end), start, end, matchStart: match.index, matchEnd: match.index + match[0].length } };
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
    Object.assign(result.coverage, { ...counts(), matchingPassagesReturned: state.matchesReturned, unexaminedBodies: exhausted ? state.failedBodies : 'unknown', pendingBody: state.pending !== null, completeWithinScope: exhausted && state.failedBodies === 0 });
    return finish(result);
  }
  async function checkVersion() {
    const version = String(await run(['--version'])).trim();
    const match = /^(?:tc\s+)?(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match || Number(match[1]) === 0 && Number(match[2]) < 9) fail('CLI_VERSION');
    cliVersion = match.slice(1).join('.');
  }
  async function diagnostics() {
    const r = envelope('diagnostics', { cliVersion, access: { authenticated: true, sqlRead: false, bodyRead: null } });
    try {
      const found = await page({}, null, 1); r.access.sqlRead = true;
      if (found.length) { r.access.bodyRead = false; await body(metadata(found[0])); r.access.bodyRead = true; }
      else r.bodyReadReason = 'No catalog record available for a body-read probe.';
    } catch (error) {
      const e = classified(error); r.ok = false; r.error = { code: e.code, message: e.message };
    }
    return finish(r);
  }
  return {
    async invoke(command, input = {}) {
      try {
        validateContext(); if (!['diagnostics', 'find', 'read', 'search'].includes(command)) fail('INVALID_INPUT');
        await checkVersion();
        await authorize();
        if (command === 'diagnostics') { keys(input, []); return await diagnostics(); }
        return await ({ find, read, search })[command](input);
      } catch (error) {
        const e = classified(error);
        return { envelopeVersion: 1, packVersion: PACK_VERSION, ok: false, command: ['diagnostics', 'find', 'read', 'search'].includes(command) ? command : null, coverage: coverage({ completeWithinScope: false }), continuation: null, error: { code: e.code, message: e.message } };
      }
    },
  };
}
