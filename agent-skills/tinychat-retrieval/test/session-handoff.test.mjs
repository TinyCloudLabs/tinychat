import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const api = await import('../lib/session-handoff.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const sessionID = 'ses_syntheticHandoff';
const build = options => {
  assert.equal(typeof api.buildSessionHandoff, 'function', 'the shipped local diagnostic exporter must exist');
  return api.buildSessionHandoff({ sessionID, messages: [], ...options });
};
const message = (parts, info = {}) => ({ info: { id: 'msg_synthetic', sessionID, role: 'assistant', providerID: 'openai', modelID: 'gpt-5.6-luna', ...info }, parts: parts.map(part => ({ sessionID, ...part })) });
const tool = (id, name, output, extras = {}) => ({ id, type: 'tool', tool: name, state: { status: 'completed', output: typeof output === 'string' ? output : JSON.stringify(output), time: { start: 100, end: 250 }, ...extras } });

test('compact continuation and batched citation checks remain safe diagnostic references', () => {
  const result = build({ messages: [message([
    tool('prt_done', 'tinychat_meetings', { ok: true, operation: 'lean', coverage: { reachedEnd: true, visibleComplete: true, originalRecords: 300, deliveredChunks: 8 }, reviews: [{ claim: 'PRIVATE_CLAIM', spans: [{ recordIndex: 3, start: 0, end: 12, text: 'PRIVATE_TEXT', speaker: 'Avery' }], checks: { semanticEntailment: 'model-review-required' } }] }),
  ])] });
  for (const text of ['reachedEnd=true', 'originalRecords=300', 'deliveredChunks=8', 'recordIndex=3', 'UTF-16 0–12']) assert.ok(result.includes(text), text);
  assert.ok(!/PRIVATE_CLAIM|PRIVATE_TEXT/.test(result));
  assert.ok(!result.includes('include the separate diagnostics probe'));
});

test('local handoff reports safe sign-in, real diagnostics, versions and distinct measured timings', () => {
  const result = build({
    goal: 'Inspect the last observed meeting and its source evidence.',
    versions: { client: 'OpenCode 1.18.31', candidate: '0.1.1-onboarding.7', cli: '0.10.0' },
    timings: { installMs: 800, modelWaitMs: 1200 },
    messages: [message([
      { id: 'prt_receipt', type: 'text', text: 'TinyChat sign-in receipt: ' + JSON.stringify({ ok: true, status: 'ready', profile: 'tinychat-agent', inputBytes: 9000, captureMs: 2.3, loginMs: 3714, access: 'not-tested', authorization: 'SECRET_AUTH_RESPONSE' }) },
      tool('prt_diagnostics', 'bash', { ok: true, command: 'diagnostics', cliVersion: '0.10.0', access: { authenticated: true, sqlRead: true, bodyRead: true } }),
      { id: 'prt_answer', type: 'text', text: 'Private meeting answer text must not be copied.' },
    ])],
  });
  for (const value of ['ses_syntheticHandoff', 'openai/gpt-5.6-luna', 'OpenCode 1.18.31', '0.1.1-onboarding.7', 'capture: 2.3 ms', 'login: 3714 ms', 'install: 800 ms', 'model wait: 1200 ms', 'orchestration: unavailable', 'diagnostics', 'sqlRead=true', 'bodyRead=true', 'prt_answer']) assert.ok(result.includes(value), value);
  assert.ok(!result.includes('SECRET_AUTH_RESPONSE'));
  assert.ok(!result.includes('Private meeting answer'));
  assert.ok(result.includes('Semantic claim support and named-speaker attribution require review'));
});

test('native completed tools retain embedded exit-1 and exit-3 failures and pending work', () => {
  const result = build({ messages: [message([
    tool('prt_cursor', 'bash', { exitCode: 1, stdout: JSON.stringify({ ok: false, command: 'read', error: { code: 'INVALID_INPUT', message: 'SECRET_CURSOR' } }) }),
    tool('prt_upload', 'bash', 'Process exited with code 3\n' + JSON.stringify({ error: { code: 'UPLOAD_AUTH_REQUIRED', message: 'SECRET_UPLOAD' } })),
    tool('prt_native_error', 'bash', '', { status: 'error', error: 'PRIVATE_NATIVE_ERROR' }),
    tool('prt_pending', 'tinychat_meetings', '', { status: 'running' }),
    tool('prt_recovered', 'tinychat_meetings', { ok: true, operation: 'op-synthetic', page: 2, chunk: 1, chunks: 1, morePages: true, spans: [] }),
  ])] });
  assert.match(result, /prt_cursor[^\n]*failed[^\n]*native completed[^\n]*exit 1[^\n]*INVALID_INPUT/);
  assert.match(result, /prt_upload[^\n]*failed[^\n]*native completed[^\n]*exit 3[^\n]*UPLOAD_AUTH_REQUIRED/);
  assert.match(result, /prt_native_error[^\n]*failed/);
  assert.match(result, /prt_pending[^\n]*pending/);
  assert.match(result, /prt_recovered[^\n]*completed/);
  assert.ok(!/SECRET_CURSOR|SECRET_UPLOAD|PRIVATE_NATIVE_ERROR/.test(result));
});

test('installed setup, meetings and handoff tools retain context, saved completion and local paths', () => {
  const result = build({ messages: [message([
    tool('prt_setup', 'tinychat_setup', { ok: true, status: 'ready', profile: 'tinychat-agent', access: 'not-tested' }),
    tool('prt_read', 'tinychat_meetings', { ok: true, operation: 'op-complete', record: { id: 'meeting-1', source: 'fireflies', sourceId: 'source-1', title: 'PRIVATE_TITLE', ref: 'PRIVATE_REF' }, spans: [{ recordIndex: 0, start: 0, end: 17, speaker: 'Avery', text: 'PRIVATE_TRANSCRIPT' }], provenance: { bodySha256: 'a'.repeat(64) } }),
    tool('prt_done', 'tinychat_meetings', { ok: true, operation: 'op-complete', pagesFetched: 4, totalSavedChunks: 4, acknowledgedChunks: 4, visibleComplete: true, artifactDirectory: '/private/tmp/consumer-operation' }),
    tool('prt_export', 'tinychat_handoff', { ok: true, status: 'exported', path: '/private/tmp/session-handoff.md' }),
  ])] });
  assert.match(result, /prt_setup: context completed[^\n]*status=ready[^\n]*profile=tinychat-agent/);
  assert.match(result, /prt_export: export completed[^\n]*local=\/private\/tmp\/session-handoff.md/);
  for (const value of ['visibleComplete=true', 'acknowledgedChunks=4', 'bodySha256=' + 'a'.repeat(64), 'source=fireflies', 'recordId=meeting-1', 'The latest reported traversal records complete evidence delivery.']) assert.ok(result.includes(value), value);
  assert.ok(!/PRIVATE_TITLE|PRIVATE_REF|PRIVATE_TRANSCRIPT/.test(result));
});

test('citation review failures remain classified without exporting claim or evidence text', () => {
  const result = build({ messages: [message([
    tool('prt_acquisition', 'tinychat_meetings', { ok: false, error: { code: 'ACQUISITION_INVALID' } }),
    tool('prt_collision', 'tinychat_meetings', { ok: false, error: { code: 'ACQUISITION_EXISTS' } }),
    tool('prt_missing', 'tinychat_meetings', { ok: false, error: { code: 'EVIDENCE_UNAVAILABLE' }, claim: 'PRIVATE_CLAIM', spans: [{ text: 'PRIVATE_EVIDENCE' }] }),
    tool('prt_speaker', 'tinychat_meetings', { ok: false, error: { code: 'SPEAKER_MISMATCH' } }),
  ])] });
  assert.match(result, /prt_acquisition: retrieval failed[^\n]*ACQUISITION_INVALID/);
  assert.match(result, /prt_collision: retrieval failed[^\n]*ACQUISITION_EXISTS/);
  assert.match(result, /prt_missing: retrieval failed[^\n]*EVIDENCE_UNAVAILABLE/);
  assert.match(result, /prt_speaker: retrieval failed[^\n]*SPEAKER_MISMATCH/);
  assert.ok(!/PRIVATE_CLAIM|PRIVATE_EVIDENCE/.test(result));
});

test('short private keys and API-key-shaped task notes are withheld', () => {
  const result = build({ goal: 'Inspect ' + '0x' + 'a'.repeat(64), nextAction: 'Use sk-synthetic-credential-for-fixture' });
  assert.ok(!result.includes('a'.repeat(64)));
  assert.ok(!result.includes('sk-synthetic'));
});

test('current revision failure requires a clean restart despite earlier completed coverage', () => {
  const result = build({ messages: [message([
    tool('prt_done', 'tinychat_meetings', { ok: true, operation: 'op-first', visibleComplete: true }),
    tool('prt_changed', 'tinychat_meetings', { ok: false, operation: 'op-new', error: { code: 'REVISION_CHANGED' } }),
  ])] });
  assert.match(result, /Next action: Start an explicit clean traversal of the same intended meeting after REVISION_CHANGED/);
  assert.ok(!result.includes('The latest reported traversal records complete evidence delivery.'));
});

test('auth-only export and an observed diagnostic CLI version produce accurate pending guidance', () => {
  const pending = build({ receipt: { sessionID, ok: true, status: 'awaiting-approval' } });
  assert.match(pending, /Next action: Complete the existing pending sign-in/);
  assert.ok(!pending.includes('Next action: Resume the intended saved operation'));
  const observed = build({ messages: [message([tool('prt_diagnostic', 'tinychat_meetings', { ok: true, command: 'diagnostics', cliVersion: '0.10.0', access: { sqlRead: true, bodyRead: true } })])] });
  assert.match(observed, /CLI version: 0\.10\.0/);
});

test('prototype-looking tool names and command values remain unknown observations', () => {
  const result = build({ messages: [message([tool('prt_unknown', 'constructor', {}), tool('prt_command', 'bash', { command: '__proto__' })])] });
  assert.match(result, /prt_unknown: tool completed/);
  assert.match(result, /prt_command: tool completed/);
  assert.ok(!result.includes('function Object'));
});

test('consumer discovery/status expose actual diagnostics and partial classified failures', () => {
  const result = build({ messages: [message([
    tool('prt_discovery', 'tinychat_meetings', { ok: true, operation: 'op-consumer', meetings: [{ meeting: 1, id: 'meeting-1', title: 'PRIVATE_TITLE' }], access: { authenticated: true, sqlRead: true, bodyRead: true, arbitraryUntrustedFlag: false } }),
    tool('prt_partial', 'tinychat_meetings', { ok: false, operation: 'op-consumer', error: { code: 'DISPLAY_INCOMPLETE' }, exitCode: 1, progress: { pagesFetched: 4, acknowledgedChunks: 3, totalSavedChunks: 4, visibleComplete: false } }),
    tool('prt_status', 'tinychat_meetings', { ok: true, operation: 'op-consumer', status: 'in-progress', pagesFetched: 4, acknowledgedChunks: 3, totalSavedChunks: 4, visibleComplete: false, lastError: { code: 'DISPLAY_INCOMPLETE' } }),
  ])] });
  assert.match(result, /prt_discovery: discovery completed/);
  assert.match(result, /prt_discovery: diagnostics completed[^\n]*authenticated=true[^\n]*sqlRead=true[^\n]*bodyRead=true/);
  assert.match(result, /prt_partial: retrieval failed[^\n]*exit 1[^\n]*DISPLAY_INCOMPLETE[^\n]*pagesFetched=4[^\n]*acknowledgedChunks=3/);
  assert.match(result, /prt_status: retrieval pending[^\n]*status=in-progress[^\n]*lastError=DISPLAY_INCOMPLETE/);
  assert.ok(!result.includes('PRIVATE_TITLE'));
});

test('measured consumer timings count only the latest snapshot per operation across display retries and failed fetches', () => {
  const result = build({ messages: [message([
    tool('prt_first', 'tinychat_meetings', { ok: true, operation: 'op-first', timings: { diagnosticsMs: 8, discoveryMs: 10, retrievalMs: 40 } }),
    tool('prt_redisplay', 'tinychat_meetings', { ok: true, operation: 'op-first', timings: { diagnosticsMs: 8, discoveryMs: 10, retrievalMs: 40 } }),
    tool('prt_failed_fetch', 'tinychat_meetings', { ok: false, operation: 'op-first', error: { code: 'NETWORK_ERROR' }, timings: { diagnosticsMs: 8, discoveryMs: 10, retrievalMs: 65 } }),
    tool('prt_status', 'tinychat_meetings', { ok: true, operation: 'op-first', status: 'in-progress', timings: { diagnosticsMs: 8, discoveryMs: 10, retrievalMs: 65 } }),
    tool('prt_other_operation', 'tinychat_meetings', { ok: true, operation: 'op-second', timings: { diagnosticsMs: 3, discoveryMs: 5, retrievalMs: 12, secret: 'PRIVATE_TIMING' } }),
  ])] });
  assert.match(result, /retrieval: 77 ms/);
  assert.match(result, /diagnostics subprocess: 11 ms/);
  assert.match(result, /discovery subprocess: 15 ms/);
  assert.match(result, /latest cumulative snapshot per operation/);
  assert.match(result, /tool elapsed 150 ms/);
  assert.ok(!result.includes('PRIVATE_TIMING'));
});

test('explicit intended session is mandatory and all native records and observations must match', () => {
  for (const options of [
    { sessionID: undefined },
    { messages: [message([], { sessionID: 'ses_other' })] },
    { messages: [message([{ id: 'prt_other', type: 'text', text: 'secret' }])] .map(value => ({ ...value, parts: value.parts.map(part => ({ ...part, sessionID: 'ses_other' })) })) },
    { receipt: { sessionID: 'ses_other', ok: true, status: 'ready' } },
    { observations: [{ sessionID: 'ses_other', stage: 'retrieval', status: 'completed' }] },
  ]) assert.throws(() => build(options), error => error.code === 'HANDOFF_SESSION_MISMATCH');
});

test('allowlisted observations preserve saved versus visible coverage and evidence identities without transcript text', () => {
  const result = build({ observations: [{
    sessionID, stage: 'retrieval', status: 'pending', operation: 'op-synthetic',
    path: '/private/tmp/fixture/operation',
    coverage: { pagesFetched: 4, acknowledgedChunks: 3, totalSavedChunks: 4, visibleComplete: false, totalRecords: 321, corpusComplete: false },
    sources: [{ recordId: 'record-42', recordIndex: 42, start: 5, end: 18, speaker: 'Avery', startSecs: 12.5, text: 'SECRET_TRANSCRIPT' }],
    error: { code: 'REVISION_CHANGED', message: 'SECRET_ERROR' },
  }] });
  for (const value of ['pagesFetched=4', 'acknowledgedChunks=3', 'visibleComplete=false', 'record-42', 'recordIndex=42', 'UTF-16 5–18', 'Avery', '12.5', '/private/tmp/fixture/operation', 'REVISION_CHANGED']) assert.ok(result.includes(value), value);
  assert.ok(!result.includes('SECRET_TRANSCRIPT'));
  assert.ok(!result.includes('SECRET_ERROR'));
  assert.ok(result.includes('Pending: read remaining saved evidence'));
});

test('raw messages, commands, provider records and secret-bearing fields never enter Markdown', () => {
  const result = build({
    goal: 'Check meeting. Authorization: Bearer SECRET_GOAL',
    nextAction: 'token=SECRET_NEXT',
    versions: { candidate: 'Bearer SECRET_VERSION' },
    timings: { captureMs: -1, loginMs: Infinity },
    messages: [message([
      { type: 'text', id: 'prt_user', text: 'SECRET_RAW_INPUT' },
      tool('prt_bash', 'bash', JSON.stringify({ arbitrary: 'SECRET_OUTPUT', privateKey: 'SECRET_KEY', authorization: 'SECRET_AUTH', command: 'echo SECRET_COMMAND' }), { input: { command: 'tc share publish SECRET_COMMAND' }, title: 'SECRET_TITLE', metadata: { provider: { apiKey: 'SECRET_PROVIDER' } } }),
      tool('prt_unknown', 'SECRET_TOOL', { ok: true, command: 'read', continuation: 'SECRET_CONTINUATION' }),
    ], { role: 'user', provider: { apiKey: 'SECRET_PROVIDER' }, history: 'SECRET_HISTORY' })],
  });
  assert.ok(!result.includes('SECRET_'), result);
  assert.ok(result.includes('[withheld: sensitive content]'));
  assert.ok(result.includes('capture: unavailable'));
  assert.ok(result.includes('login: unavailable'));
});

test('writer creates one exclusive mode-0600 local artifact and cannot overwrite or accept relative paths', async t => {
  assert.equal(typeof api.exportSessionHandoff, 'function', 'the shipped writer must exist');
  const root = await mkdtemp(join(tmpdir(), 'tinychat-handoff-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'handoff.md');
  const result = await api.exportSessionHandoff({ sessionID, messages: [], outputPath: path });
  assert.deepEqual(result, { ok: true, status: 'exported', sessionID, path });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const original = await readFile(path, 'utf8');
  assert.match(original, /Local diagnostic handoff/);
  await assert.rejects(api.exportSessionHandoff({ sessionID, messages: [], outputPath: path }), error => error.code === 'HANDOFF_PATH_EXISTS');
  assert.equal(await readFile(path, 'utf8'), original);
  await assert.rejects(api.exportSessionHandoff({ sessionID, messages: [], outputPath: 'relative.md' }), error => error.code === 'HANDOFF_PATH_INVALID');
  const source = await readFile(new URL('../lib/session-handoff.mjs', import.meta.url), 'utf8');
  assert.ok(!/child_process|\bfetch\s*\(|runTc|execFile|spawn\s*\(/.test(source), 'export has no process, auth or upload capability');
});

test('long macOS temporary paths remain local artifact paths rather than opaque tokens', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tinychat-handoff-path-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'tinychat-experience-KNc5pn', 'tinychat-session-12345678-1234-1234-1234-123456789012');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const outputPath = join(directory, 'session-handoff.md');
  const result = await api.exportSessionHandoff({ sessionID, messages: [], outputPath, observations: [{ sessionID, stage: 'retrieval', status: 'pending', path: directory }] });
  assert.equal(result.path, outputPath);
  assert.ok((await readFile(outputPath, 'utf8')).includes(directory));
  await assert.rejects(api.exportSessionHandoff({ sessionID, messages: [], outputPath: join(root, 'x'.repeat(120), 'handoff.md') }), error => error.code === 'HANDOFF_PATH_INVALID');
});

test('missing Node is preserved as a runtime failure with a setup recovery action', () => {
  const result = build({ messages: [message([
    tool('prt_runtime', 'tinychat_meetings', { ok: false, operation: 'op-runtime', stage: 'diagnostics', error: { code: 'NODE_UNAVAILABLE', message: 'PRIVATE_PROCESS_DETAILS' }, exitCode: 1, progress: { pagesFetched: 0, visibleComplete: false } }),
  ])] });
  assert.match(result, /prt_runtime: diagnostics failed[^\n]*exit 1[^\n]*NODE_UNAVAILABLE/);
  assert.match(result, /Next action: Restore Node.js 20 or later on the client PATH/);
  assert.ok(!result.includes('PRIVATE_PROCESS_DETAILS'));
});

test('historical local pages report acquisition semantics and counts without inventing failed diagnostics', () => {
  const result = build({ messages: [message([
    tool('prt_latest', 'tinychat_meetings', { ok: true, operation: 'latest', meetings: [], selection: { status: 'selected', resolved: true }, access: { authenticated: true, sqlRead: true, bodyRead: true } }),
    tool('prt_local', 'tinychat_meetings', { ok: true, operation: 'latest', acquisition: { mode: 'local-historical', binding: 'PRIVATE_BINDING' }, access: { authenticated: false, sqlRead: false, bodyRead: false, currentAuthorityVerified: false, currentBodyRevisionVerified: false } }),
    tool('prt_counts', 'tinychat_meetings', { ok: true, operation: 'latest', status: 'in-progress', access: { authenticated: true, sqlRead: true, bodyRead: true }, counts: { meetingListings: 1, transcriptSegments: 20, remoteBodyAcquisitions: 2, remoteBodyBytes: 90000, localDisplayChunks: 8, localReviewsCompleted: 2, secret: 'PRIVATE_COUNT' } }),
  ])] });
  assert.ok(!result.includes('prt_local: diagnostics failed'));
  assert.ok(!result.includes('prt_counts: diagnostics completed'), 'status must not invent a new diagnostic event');
  for (const text of ['acquisition=local-historical', 'currentAuthorityVerified=false', 'meetingListings=1', 'transcriptSegments=20', 'remoteBodyAcquisitions=2', 'remoteBodyBytes=90000', 'localDisplayChunks=8', 'localReviewsCompleted=2', 'selection=selected']) assert.ok(result.includes(text), text);
  assert.ok(!/PRIVATE_BINDING|PRIVATE_COUNT/.test(result));
});
