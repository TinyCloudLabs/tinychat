import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSpanEvidence } from './evidence.mjs';
import { decodeBody, RetrievalError } from './retrieval.mjs';

// Adapter budget verified through OpenCode 1.18.31 tool truncation and model-input conversion.
export const DISPLAY_BYTES = 96 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value) + '\n';
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
const handle = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const messages = {
  INVALID_INPUT: 'Use latest or discover with a short operation; follow nextAction with its explicit chunk. No receipt, review, display-size, reference, cursor or transcript arguments are accepted.',
  PRIVATE_DIRECTORY_REQUIRED: 'Consumer storage must be a private directory outside the project.',
  OPERATION_REQUIRED: 'Use latest or discover with a new short operation handle first.',
  OPERATION_MISMATCH: 'This operation already belongs to a different discovery. Use its saved filters or a new operation.',
  OPERATION_BUSY: 'Another command owns this operation lock. Retry after it finishes; retain a stale lock for inspection.',
  SESSION_MISMATCH: 'This operation belongs to another conversation. Start a separate discovery operation.',
  CONTEXT_MISMATCH: 'The verified profile, host, space, owner or session key changed. Keep this operation intact.',
  MEETING_REQUIRED: 'Select an explicit meeting index from this operation’s saved discovery.',
  MEETING_MISMATCH: 'This operation is already bound to another meeting. Use a separate operation.',
  DISPLAY_INCOMPLETE: 'The client has not delivered the complete evidence payload. Repeat its original action to return it again.',
  DISPLAY_RECEIPT_INVALID: 'Client delivery must match the exact issued evidence output for this operation and conversation.',
  EVIDENCE_UNAVAILABLE: 'The selected original record or UTF-16 interval is absent from this operation’s saved evidence. Use indices and offsets from its displayed spans.',
  SPEAKER_MISMATCH: 'The exact attributed speaker must match every selected span. Unknown speakers and other speakers cannot support that attribution. Correct the evidence or the claim’s attribution; do not omit speaker to bypass a named-attribution check.',
  OUTPUT_LIMIT: 'A source metadata record exceeds the adapter output budget. Evidence was not truncated. Preserve the operation for inspection; changing text intervals or adding review options cannot repair metadata.',
  PAGE_OUT_OF_ORDER: 'Use the next consecutive page or redisplay a saved page; completed prefixes are never refetched.',
  TRAVERSAL_COMPLETE: 'There is no more evidence; use the returned references to answer.',
  FILE_COLLISION: 'An output file already exists. It was not overwritten or fetched again; inspect this operation’s evidence.',
  STATE_INCOMPLETE: 'Saved operation evidence is missing or invalid. Keep it intact and inspect it before restarting.',
  REVISION_CHANGED: 'The source body changed. Explicitly restart into a new operation; do not combine these revisions.',
  CONSUMER_ERROR: 'The consumer failed. Saved progress remains private and intact.',
  SETUP_CONFIG_REQUIRED: 'Prepare the installed TinyChat setup before starting retrieval.',
  SETUP_CONFIG_INVALID: 'The selected TinyChat setup is invalid. Preserve it and inspect the app configuration.',
  NODE_UNAVAILABLE: 'Node.js 20 or later must be available as node on the installed client PATH. Restore that runtime; keep the selected TinyCloud profile and authorization.',
};
function safeError(code) {
  if (Object.hasOwn(messages, code)) return { code, message: messages[code] };
  const error = new RetrievalError(code);
  return error.message === new RetrievalError('CLI_ERROR').message && code !== 'CLI_ERROR'
    ? { code: 'CONSUMER_ERROR', message: messages.CONSUMER_ERROR }
    : { code, message: error.message };
}
function binding(context) {
  if (!object(context) || context.status !== 'ready' || ['profile', 'host', 'space', 'owner', 'sessionDid'].some(key => typeof context[key] !== 'string' || !context[key])) fail('CONTEXT_MISMATCH');
  const args = context.retrievalArgs;
  if (!Array.isArray(args) || args.length < 8 || args.length % 2) fail('CONTEXT_MISMATCH');
  const actual = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!['profile', 'host', 'space', 'owner', 'tc'].includes(key) || Object.hasOwn(actual, key) || typeof args[i + 1] !== 'string') fail('CONTEXT_MISMATCH');
    actual[key] = args[i + 1];
  }
  if (['profile', 'host', 'space', 'owner'].some(key => actual[key] !== context[key])) fail('CONTEXT_MISMATCH');
  return JSON.stringify(['profile', 'host', 'space', 'owner', 'sessionDid'].map(key => context[key]));
}
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
async function privateInfo(path, directory = false) {
  let info;
  try { info = await lstat(path); } catch { fail('STATE_INCOMPLETE'); }
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) fail('PRIVATE_DIRECTORY_REQUIRED');
  return info;
}
async function loadJson(path) {
  await privateInfo(path);
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { fail('STATE_INCOMPLETE'); }
}
function defaultRun(packRoot) {
  return args => new Promise(resolveResult => {
    // In the compiled OpenCode host, process.execPath is the OpenCode binary,
    // not a JavaScript interpreter. The installed client PATH provides Node.
    execFile('node', [join(packRoot, 'scripts/retrieve.mjs'), ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => {
      resolveResult({ stdout, exitCode: error ? Number.isInteger(error.code) ? error.code : 1 : 0, errorCode: error?.signal ? 'TIMEOUT' : error?.code === 'ENOENT' ? 'NODE_UNAVAILABLE' : undefined });
    });
  });
}
const boundary = (text, offset) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]) ? offset - 1 : offset;
/** One retained acquisition; direct references and explicit, repeatable continuation chunks. */
export function createConsumer({ setup, root = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'tinychat-retrieval/operations'), packRoot = fileURLToPath(new URL('../', import.meta.url)), projectRoot = process.cwd(), projectDirectory = projectRoot, run = defaultRun(packRoot) } = {}) {
  async function invoke(command, input = {}, { sessionID, deliveryOutput } = {}) {
    let directory, state, lock, canSave = false;
    const progress = () => ({ deliveredChunks: state?.delivered ?? 0, totalChunks: state?.layout?.length ?? 0, visibleComplete: !!state?.layout?.length && state.delivered === state.layout.length });
    const save = async () => {
      const temporary = join(directory, `state-${randomUUID()}.tmp`);
      await writeFile(temporary, json(state), { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(directory, 'state.json'));
    };
    const failed = (code, exitCode = 1, extra = {}) => ({ ok: false, operation: input.operation, error: safeError(code), exitCode, ...extra, ...(state ? { progress: progress() } : {}) });
    const response = async descriptor => {
      if (!descriptor || !/^(?:discovery-[1-9][0-9]*|acquired)-attempt-[1-9][0-9]*\.response\.json$/.test(descriptor.file)) fail('STATE_INCOMPLETE');
      const path = join(directory, descriptor.file);
      await privateInfo(path);
      const raw = await readFile(path, 'utf8').catch(() => fail('STATE_INCOMPLETE'));
      if (digest(raw) !== descriptor.sha256) fail('STATE_INCOMPLETE');
      try { return JSON.parse(raw); } catch { fail('STATE_INCOMPLETE'); }
    };
    const fetch = async (name, action, args, prior) => {
      const attempt = (prior?.attempt ?? 0) + 1, file = `${name}-attempt-${attempt}.response.json`;
      const processFile = join(directory, `${name}-attempt-${attempt}.process.json`);
      let owned, processOwned;
      try {
        processOwned = await open(processFile, 'wx', 0o600);
        owned = await open(join(directory, file), 'wx', 0o600);
      } catch (error) {
        if (processOwned) { await processOwned.close(); await unlink(processFile); }
        if (error.code === 'EEXIST') fail('FILE_COLLISION');
        throw error;
      }
      const started = performance.now();
      let result;
      try { result = await run([action, ...state.context.retrievalArgs, ...args]); }
      catch (error) { result = { stdout: '', exitCode: 1, errorCode: error.code }; }
      const raw = typeof result.stdout === 'string' ? result.stdout : '';
      try { await owned.writeFile(raw); } finally { await owned.close(); }
      const descriptor = { file, attempt, sha256: digest(raw), exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 1, elapsedMs: Math.round(performance.now() - started) };
      state.timings[action === 'read' ? 'retrievalMs' : 'discoveryMs'] += descriptor.elapsedMs;
      let value;
      try { value = JSON.parse(raw); } catch { value = { ok: false, error: safeError(result.errorCode ?? 'INVALID_RESPONSE') }; }
      if (value?.ok === true && (value.command !== action || !object(value.context) || ['profile', 'host', 'space', 'owner'].some(key => value.context[key] !== (key === 'owner' ? state.context[key].toLowerCase() : state.context[key])))) value = { ok: false, error: safeError('CONTEXT_MISMATCH') };
      if (value?.ok === true && !(value.continuation === null || typeof value.continuation === 'string' && value.continuation.length > 0)) value = { ok: false, error: safeError('INVALID_RESPONSE') };
      if (object(value?.transfers) && ['remoteBodyAcquisitions', 'remoteBodyBytes'].every(key => Number.isSafeInteger(value.transfers[key]) && value.transfers[key] >= 0)) {
        descriptor.transfers = value.transfers;
        for (const key of ['remoteBodyAcquisitions', 'remoteBodyBytes']) state.counts[key] += value.transfers[key];
      }
      descriptor.ok = value?.ok === true && descriptor.exitCode === 0;
      if (!descriptor.ok) { descriptor.error = safeError(value?.error?.code ?? result.errorCode ?? 'INVALID_RESPONSE'); descriptor.exitCode ||= 1; }
      try { await processOwned.writeFile(json(descriptor)); } finally { await processOwned.close(); }
      return { descriptor, value };
    };
    const acquisitionBinding = () => digest(JSON.stringify([state.operation, state.sessionHash, state.binding]));
    const retained = async () => {
      const acquired = state.acquired;
      if (!acquired?.ok || !/^acquisition-attempt-[1-9][0-9]*$/.test(acquired.acquisitionDirectory ?? '')) fail('STATE_INCOMPLETE');
      const value = await response(acquired);
      if (!object(value.record) || ['id', 'source', 'sourceId'].some(key => value.record[key] !== state.selected[key])) fail('MEETING_MISMATCH');
      const path = join(directory, acquired.acquisitionDirectory);
      await privateInfo(path, true);
      const manifestPath = join(path, 'manifest.json'), bodyPath = join(path, 'body');
      await privateInfo(manifestPath); const info = await privateInfo(bodyPath);
      if (info.size > 8 * 1024 * 1024) fail('ACQUISITION_INVALID');
      const raw = await readFile(manifestPath, 'utf8');
      if (digest(raw) !== value.acquisition?.manifestSha256) fail('ACQUISITION_INVALID');
      let manifest; try { manifest = JSON.parse(raw); } catch { fail('ACQUISITION_INVALID'); }
      if (manifest.v !== 1 || manifest.binding !== acquisitionBinding() || value.acquisition.binding !== manifest.binding ||
          manifest.ref !== state.selected.ref || manifest.bodySha256 !== value.provenance?.bodySha256 ||
          ['profile', 'host', 'space', 'owner'].some(key => manifest.context?.[key] !== (key === 'owner' ? state.context[key].toLowerCase() : state.context[key]))) fail('ACQUISITION_INVALID');
      const body = await readFile(bodyPath);
      if (digest(body) !== manifest.bodySha256) fail('ACQUISITION_INVALID');
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { fail('ACQUISITION_INVALID'); }
      const records = decodeBody(text);
      if (state.layout !== undefined) {
        if (!Array.isArray(state.layout) || !state.layout.length || !Number.isSafeInteger(state.delivered) || state.delivered < 0 || state.delivered > state.layout.length || !Array.isArray(state.issued) || state.issued.some(index => !Number.isSafeInteger(index) || index < 0 || index >= state.layout.length) || new Set(state.issued).size !== state.issued.length || Array.from({ length: state.delivered }, (_, index) => index).some(index => !state.issued.includes(index))) fail('STATE_INCOMPLETE');
        let recordIndex = 0, offset = 0;
        for (const selectors of state.layout) {
          if (!Array.isArray(selectors) || !selectors.length) fail('STATE_INCOMPLETE');
          for (const selection of selectors) {
            const original = records[recordIndex];
            if (!object(selection) || !original || selection.recordIndex !== recordIndex || selection.start !== offset || !Number.isSafeInteger(selection.end) || selection.end < offset || selection.end === offset && original.end > offset || selection.end > original.end || boundary(original.text, selection.end) !== selection.end) fail('STATE_INCOMPLETE');
            offset = selection.end;
            if (offset === original.end) { recordIndex++; offset = 0; }
          }
        }
        if (recordIndex !== records.length || offset !== 0) fail('STATE_INCOMPLETE');
      }
      return { value, records };
    };
    const show = (evidence, selectors, index, total = state.layout?.length ?? 999999) => {
      const { value, records } = evidence;
      const spans = selectors.map(selection => {
        const original = records[selection.recordIndex];
        const span = { ...original, start: selection.start, end: selection.end, text: original.text.slice(selection.start, selection.end) };
        formatSpanEvidence(value.record, span, value.provenance);
        return { ref: `${state.operation}/r${span.recordIndex}:${span.start}-${span.end}`, ...span };
      });
      return {
        ok: true, operation: state.operation, meeting: state.selected.index, evidence: value.provenance.bodySha256.slice(0, 16),
        ...(index === 0 ? { record: { id: value.record.id, source: value.record.source, sourceId: value.record.sourceId, title: value.record.title, startedAt: value.record.startedAt }, provenance: { contentKind: value.provenance.contentKind, bodySha256: value.provenance.bodySha256, acquiredAt: value.acquisition.acquiredAt, atomicSnapshot: false, offsetUnit: 'UTF-16', originalRecords: records.length, captureComplete: null, excludedCatalogs: value.coverage.excludedCatalogs }, ...(state.selection ? { selection: state.selection } : {}), accessMeaning: 'Historical acquired evidence; current remote authority and body revision are unobserved during local continuation.' } : {}),
        access: { currentAuthorityVerified: false, currentBodyRevisionVerified: false },
        coverage: { corpusComplete: false, chunk: index + 1, chunks: total, returnedComplete: index + 1 === total, visibleComplete: false, originalRecords: records.length },
        ...(index === 0 ? { citationGuide: 'Cite the delivered ref with this meeting title, observed speaker and timestamp. Offsets are original UTF-16, end exclusive. Unknown speakers cannot support named attribution; generated notes are not verbatim speech. Check meaning against the exact text.' } : {}),
        counts: state.counts, timings: state.timings, cliVersion: value.cliVersion,
        spans,
        nextAction: index + 1 === total ? null : { action: 'next', operation: state.operation, chunk: index + 2 },
      };
    };
    const pack = evidence => {
      const layout = []; let selectors = [];
      const fits = pieces => Buffer.byteLength(json(show(evidence, pieces, layout.length, 999999))) <= DISPLAY_BYTES - 64;
      for (const original of evidence.records) {
        let start = 0;
        do {
          if (fits([...selectors, { recordIndex: original.recordIndex, start, end: original.end }])) {
            selectors.push({ recordIndex: original.recordIndex, start, end: original.end }); break;
          }
          let low = start, high = original.end, best = -1;
          while (low <= high) {
            const middle = Math.floor((low + high) / 2), end = boundary(original.text, middle);
            if (fits([...selectors, { recordIndex: original.recordIndex, start, end }])) { best = end; low = middle + 1; } else high = middle - 1;
          }
          if (best < start || best === start && start < original.end) {
            if (!selectors.length) fail('OUTPUT_LIMIT');
            layout.push(selectors); selectors = []; continue;
          }
          selectors.push({ recordIndex: original.recordIndex, start, end: best }); start = best;
          if (start < original.end) { layout.push(selectors); selectors = []; }
        } while (start < original.end);
      }
      if (selectors.length) layout.push(selectors);
      if (!layout.length) fail('INVALID_RESPONSE');
      return layout;
    };
    const emit = async (index, evidence) => {
      if (!state.layout) { state.layout = pack(evidence); state.delivered = 0; state.issued = []; }
      if (!state.layout[index]) fail('STATE_INCOMPLETE');
      const result = show(evidence, state.layout[index], index);
      if (Buffer.byteLength(json(result)) > DISPLAY_BYTES) fail('OUTPUT_LIMIT');
      if (!state.issued.includes(index)) state.issued.push(index);
      state.outputHashes ??= {};
      state.outputHashes[index] = digest(JSON.stringify(result));
      await save();
      return result;
    };
    const acquire = async () => {
      if (!state.acquired?.ok && (!state.acquired || input.retry)) {
        const acquisitionDirectory = `acquisition-attempt-${(state.acquired?.attempt ?? 0) + 1}`;
        const fetched = await fetch('acquired', 'read', ['--ref', state.selected.ref, '--acquisition-dir', join(directory, acquisitionDirectory), '--acquisition-binding', acquisitionBinding()], state.acquired);
        state.acquired = { ...fetched.descriptor, acquisitionDirectory };
        if (state.acquired.ok) { state.counts.transcriptSegments = fetched.value.provenance?.originalRecords ?? null; state.cliVersion = fetched.value.cliVersion; }
        else state.lastError = state.acquired.error;
        await save();
      }
      if (!state.acquired.ok) return failed(state.acquired.error.code, state.acquired.exitCode, { stage: 'acquisition' });
      return emit(0, await retained());
    };
    const status = () => ({ ok: true, operation: state.operation, ...progress(), meeting: state.selected?.index ?? null, counts: state.counts, timings: state.timings, artifactDirectory: directory, access: { currentAuthorityVerified: false, currentBodyRevisionVerified: false }, nextAction: progress().visibleComplete ? null : state.layout ? { action: 'next', operation: state.operation, chunk: state.delivered + 1 } : null });
    try {
      const allowed = {
        latest: ['operation', 'source', 'from', 'to', 'retry'],
        discover: ['operation', 'page', 'term', 'source', 'from', 'to', 'limit', 'retry'],
        read: ['operation', 'meeting', 'retry'], next: ['operation', 'chunk'],
        status: ['operation'], restart: ['operation', 'newOperation'],
        ...(typeof deliveryOutput === 'string' ? { _delivery: ['operation', 'chunk'] } : {}),
      };
      if (!object(input) || !allowed[command] || Object.keys(input).some(key => input[key] !== undefined && !allowed[command].includes(key)) || !handle(input.operation) || typeof sessionID !== 'string' || !sessionID || input.retry !== undefined && typeof input.retry !== 'boolean') fail('INVALID_INPUT');
      if (['next', '_delivery'].includes(command) && !integer(input.chunk)) fail('INVALID_INPUT');
      if (!isAbsolute(root) || inside(resolve(projectDirectory), resolve(root))) fail('PRIVATE_DIRECTORY_REQUIRED');
      await mkdir(root, { recursive: true, mode: 0o700 }); await privateInfo(root, true);
      if (inside(await realpath(projectDirectory), await realpath(root))) fail('PRIVATE_DIRECTORY_REQUIRED');
      directory = join(root, input.operation);
      try { await mkdir(directory, { mode: 0o700 }); if (!['discover', 'latest'].includes(command)) fail('OPERATION_REQUIRED'); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await privateInfo(directory, true);
      try { lock = await open(join(directory, 'operation.lock'), 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('OPERATION_BUSY'); throw error; }
      try { state = await loadJson(join(directory, 'state.json')); }
      catch (error) { if (!['discover', 'latest'].includes(command)) throw error; if (await lstat(join(directory, 'state.json')).catch(() => null)) throw error; }
      if (state && (state.schemaVersion !== 3 || state.operation !== input.operation || !object(state.discoveries) || !object(state.context))) fail('STATE_INCOMPLETE');
      if (state && state.sessionHash !== digest(sessionID)) fail('SESSION_MISMATCH');
      if (command === '_delivery') {
        await retained();
        const index = input.chunk - 1;
        if (!state.issued?.includes(index) || state.outputHashes?.[index] !== digest(deliveryOutput) || index > state.delivered) fail('DISPLAY_RECEIPT_INVALID');
        state.delivered = Math.max(state.delivered, index + 1);
        await save();
        return { ok: true, ...progress() };
      }
      const local = state && command !== 'restart' && !(command === 'read' && !state.acquired?.ok) && !(command === 'latest' && !state.acquired?.ok);
      const context = local && typeof setup.guard === 'function' ? await setup.guard(state.context) : await setup.context();
      const contextBinding = binding(context);
      if (state && state.binding !== contextBinding) fail('CONTEXT_MISMATCH');
      canSave = true;
      if (!state) {
        state = { schemaVersion: 3, operation: input.operation, sessionHash: digest(sessionID), binding: contextBinding, context, discoveryMode: command, discoveries: {}, delivered: 0, issued: [], counts: { meetingListings: 0, transcriptSegments: 0, remoteBodyAcquisitions: 0, remoteBodyBytes: 0 }, timings: { discoveryMs: 0, retrievalMs: 0 }, createdAt: new Date().toISOString() };
        await writeFile(join(directory, 'setup-attempt-1.response.json'), json(context), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code === 'EEXIST') fail('FILE_COLLISION'); throw error; });
        await save();
      }
      if (command === 'status') { if (state.acquired?.ok) await retained(); return status(); }
      if (command === 'restart') {
        if (!handle(input.newOperation) || input.newOperation === input.operation) fail('INVALID_INPUT');
        if (!state.selected) fail('MEETING_REQUIRED');
        const destination = join(root, input.newOperation);
        try { await mkdir(destination, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('FILE_COLLISION'); throw error; }
        const next = { ...state, operation: input.newOperation, context, acquired: undefined, layout: undefined, delivered: 0, issued: [], outputHashes: {}, lastError: null, counts: { ...state.counts, remoteBodyAcquisitions: 0, remoteBodyBytes: 0, transcriptSegments: 0 }, timings: { discoveryMs: 0, retrievalMs: 0 }, createdAt: new Date().toISOString(), restartedFrom: input.operation };
        for (const descriptor of Object.values(state.discoveries)) {
          await response(descriptor);
          await writeFile(join(destination, descriptor.file), await readFile(join(directory, descriptor.file)), { flag: 'wx', mode: 0o600 });
        }
        await writeFile(join(destination, 'setup-attempt-1.response.json'), json(context), { flag: 'wx', mode: 0o600 });
        await writeFile(join(destination, 'state.json'), json(next), { flag: 'wx', mode: 0o600 });
        return await invoke('read', { operation: input.newOperation }, { sessionID });
      }
      if (['discover', 'latest'].includes(command)) {
        if (state.discoveryMode !== command) fail('OPERATION_MISMATCH');
        const page = input.page ?? 1;
        if (!integer(page)) fail('INVALID_INPUT');
        const supplied = Object.fromEntries(['term', 'source', 'from', 'to', 'limit'].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
        if (supplied.limit !== undefined && (!integer(supplied.limit) || supplied.limit > 10)) fail('INVALID_INPUT');
        if (state.filters && Object.keys(supplied).some(key => supplied[key] !== state.filters[key])) fail('OPERATION_MISMATCH');
        state.filters ??= { ...(command === 'discover' ? { limit: 5 } : {}), ...supplied };
        if (state.selected && !state.discoveries[page]) fail('MEETING_MISMATCH');
        let descriptor = state.discoveries[page], value;
        if (!descriptor || !descriptor.ok && input.retry) {
          if (page > 1 && !state.discoveries[page - 1]?.ok) fail('PAGE_OUT_OF_ORDER');
          const previous = page > 1 ? await response(state.discoveries[page - 1]) : null;
          if (previous && previous.continuation === null) fail('TRAVERSAL_COMPLETE');
          const args = previous ? ['--cursor', previous.continuation] : Object.entries(state.filters).flatMap(([key, value]) => [`--${key}`, String(value)]);
          const fetched = await fetch(`discovery-${page}`, command === 'latest' ? 'latest' : 'find', args, descriptor);
          descriptor = fetched.descriptor; value = fetched.value;
          if (descriptor.ok && (!Array.isArray(value.records) || value.records.some(record => typeof record.ref !== 'string' || !record.ref) || command === 'latest' && (!object(value.selection) || typeof value.selection.resolved !== 'boolean' || value.records.length > 1 || value.selection.resolved && value.records.length !== 1 || value.continuation !== null))) {
            descriptor.ok = false; descriptor.error = safeError('INVALID_RESPONSE'); descriptor.exitCode = 1;
          }
          if (descriptor.ok) state.counts.meetingListings += value.records.length;
          state.discoveries[page] = descriptor;
          if (!descriptor.ok) state.lastError = descriptor.error;
          await save();
        }
        if (!descriptor.ok) return failed(descriptor.error.code, descriptor.exitCode, { stage: 'discovery', page });
        value ??= await response(descriptor);
        if (command === 'latest' && value.selection.resolved) {
          state.selected ??= { ...value.records[0], index: 1 }; state.selection = value.selection;
          await save(); return await acquire();
        }
        let offset = 0;
        for (let i = 1; i < page; i++) offset += (await response(state.discoveries[i])).records.length;
        const result = { ok: true, operation: input.operation, page, meetings: value.records.map((record, index) => ({ meeting: offset + index + 1, id: record.id, source: record.source, title: record.title, startedAt: record.startedAt })), coverage: value.coverage, moreDiscovery: value.continuation !== null, ...(command === 'latest' ? { selection: value.selection, nextAction: null } : {}) };
        if (Buffer.byteLength(json(result)) > DISPLAY_BYTES) fail('OUTPUT_LIMIT');
        return result;
      }
      if (command === 'read') {
        const discovered = [];
        for (let i = 1; state.discoveries[i]?.ok; i++) discovered.push(...(await response(state.discoveries[i])).records);
        if (!state.selected) {
          if (!integer(input.meeting) || !discovered[input.meeting - 1]) fail('MEETING_REQUIRED');
          state.selected = { ...discovered[input.meeting - 1], index: input.meeting }; await save();
        } else if (input.meeting !== undefined && input.meeting !== state.selected.index) fail('MEETING_MISMATCH');
        return await acquire();
      }
      const evidence = await retained();
      if (!state.layout?.[input.chunk - 1]) fail('TRAVERSAL_COMPLETE');
      return await emit(input.chunk - 1, evidence);
    } catch (error) {
      const result = failed(error.code === 'ENOENT' ? 'STATE_INCOMPLETE' : error.code);
      if (lock) {
        try {
          await writeFile(join(directory, `error-${randomUUID()}.json`), json(result), { flag: 'wx', mode: 0o600 });
          if (canSave && state) { state.lastError = result.error; await save(); }
        } catch { /* Preserve the original failure and all saved evidence. */ }
      }
      return result;
    } finally {
      if (lock) { await lock.close(); await unlink(join(directory, 'operation.lock')); }
    }
  }
  return {
    invoke,
    async diagnostics({ sessionID } = {}) {
      if (typeof sessionID !== 'string' || !sessionID) return [];
      let entries;
      try { await privateInfo(root, true); entries = await readdir(root); } catch { return []; }
      const observations = [];
      for (const operation of entries.filter(handle)) {
        const directory = join(root, operation);
        let state;
        try { await privateInfo(directory, true); state = await loadJson(join(directory, 'state.json')); }
        catch { continue; } // No readable session binding: do not attribute this directory to the current session.
        if (state.schemaVersion !== 3 || state.sessionHash !== digest(sessionID) || state.operation !== operation) continue;
        observations.push({ sessionID, stage: 'retrieval', operation, status: state.acquired?.ok ? 'completed' : state.lastError ? 'failed' : 'pending',
          ...(state.lastError ? { lastError: state.lastError, ...(!state.acquired?.ok ? { error: state.lastError } : {}) } : {}),
          visibleComplete: !!state.layout?.length && state.delivered === state.layout.length,
          deliveredChunks: state.delivered, totalChunks: state.layout?.length ?? 0,
          counts: state.counts, timings: state.timings, cliVersion: state.cliVersion });
      }
      return observations;
    },
    async confirmDelivery(output, { sessionID } = {}) {
      let value;
      try { value = JSON.parse(output); } catch { return { ok: false, error: safeError('DISPLAY_RECEIPT_INVALID') }; }
      if (!value?.ok || !Array.isArray(value.spans) || !integer(value.coverage?.chunk)) return { ok: false, error: safeError('DISPLAY_RECEIPT_INVALID') };
      return invoke('_delivery', { operation: value.operation, chunk: value.coverage.chunk }, { sessionID, deliveryOutput: output });
    },
  };
}
