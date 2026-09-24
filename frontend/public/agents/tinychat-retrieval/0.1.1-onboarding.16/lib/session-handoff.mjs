import { writeFile } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

const stages = new Set(['auth', 'context', 'diagnostics', 'discovery', 'retrieval', 'export', 'install']);
const toolStages = { tinychat_authorize: 'auth', tinychat_signin_status: 'auth', tinychat_setup: 'context', tinychat_context: 'context', tinychat_diagnostics: 'diagnostics', tinychat_meetings: 'retrieval', tinychat_handoff: 'export', tinychat_export_session: 'export' };
const knownTools = new Set([...Object.keys(toolStages), 'bash', 'read', 'glob', 'grep', 'write', 'edit', 'apply_patch', 'skill']);
const commands = { diagnostics: 'diagnostics', find: 'discovery', latest: 'discovery', read: 'retrieval', search: 'retrieval', context: 'context', prepare: 'context' };
const errors = new Set(('INVALID_INPUT INVALID_RESPONSE INVALID_METADATA AUTH_REQUIRED AUTH_EXPIRED AUTH_OR_PERMISSION PERMISSION_DENIED OWNER_MISMATCH CONTEXT_MISMATCH SOURCE_CHANGED REVISION_CHANGED MEETING_NOT_FOUND MISSING_BODY EMPTY_BODY UNSUPPORTED_FORMAT UNSUPPORTED_SOURCE SPACE_NOT_HOSTED NETWORK_ERROR OUTPUT_LIMIT TIMEOUT CANCELLED CLI_UNAVAILABLE NODE_UNAVAILABLE CLI_VERSION CLI_ERROR UPLOAD_AUTH_REQUIRED INVALID_AUTH_RESPONSE AUTH_RESPONSE_REJECTED OPENKEY_PROOF_INVALID OPENKEY_SCOPE_MISMATCH OPENKEY_GRANT_BROADENED AUTH_TRANSPORT_TIMEOUT SETUP_CONFIG_REQUIRED SETUP_CONFIG_INVALID APPROVAL_CONTEXT_CHANGED BROWSER_OPEN_FAILED SIGNIN_FAILED CONVERSATION_REQUIRED CONVERSATION_MISMATCH NO_PENDING_APPROVAL DUPLICATE_AUTH_RESPONSE AMBIGUOUS_AUTH_RESPONSE AUTH_CAPTURE_IN_PROGRESS APPROVAL_IN_ANOTHER_SESSION AUTHORIZATION_IN_PROGRESS').split(' '));
for (const value of 'ACQUISITION_INVALID ACQUISITION_EXISTS PRIVATE_DIRECTORY_REQUIRED OPERATION_REQUIRED OPERATION_MISMATCH OPERATION_BUSY SESSION_MISMATCH MEETING_REQUIRED MEETING_MISMATCH DISPLAY_INCOMPLETE DISPLAY_RECEIPT_INVALID PAGE_OUT_OF_ORDER TRAVERSAL_COMPLETE FILE_COLLISION STATE_INCOMPLETE CONSUMER_ERROR CONSUMER_FAILED SETUP_FAILED SESSION_READ_FAILED LOCAL_EXPORT_FAILED INVALID_EVIDENCE SPEAKER_MISMATCH EVIDENCE_UNAVAILABLE'.split(' ')) errors.add(value);
const coverageFields = ['returnedComplete', 'chunk', 'chunks', 'totalChunks', 'pagesFetched', 'acknowledgedChunks', 'totalSavedChunks', 'visibleComplete', 'reachedEnd', 'originalRecords', 'deliveredChunks', 'totalRecords', 'returnedRecords', 'corpusComplete', 'completeWithinScope', 'traversalReachedEnd', 'fullArtifactDecoded', 'examinedRecords', 'unexaminedRecords', 'bodiesExamined', 'failedBodies', 'excludedBodies', 'unexaminedBodies'];
const sensitive = /\b(?:bearer|authorization|delegationHeader|private[ _-]?key|api[ _-]?key|password|access[ _-]?token|refresh[ _-]?token|secret|signature|siwe|cacao)\b|\btoken\s*[:=]|\b0x[a-f0-9]{64}\b|\bsk-[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/_=-]{100,}|\$\(|[`{}\u0000-\u0008\u000b-\u001f]/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:#-]{1,100}$/.test(value) ? value : undefined;
const code = value => errors.has(value) ? value : value === undefined ? undefined : 'UNCLASSIFIED_ERROR';
const note = value => typeof value !== 'string' || !value.trim() ? 'unavailable' : value.length > 600 || sensitive.test(value) ? '[withheld: sensitive content]' : value.trim().replace(/\r?\n/g, ' ').replace(/[\\*_[\]<>|]/g, '\\$&');
const path = value => typeof value === 'string' && isAbsolute(value) && value.length < 1000 && !value.split('/').some(part => sensitive.test(part)) && !/[\r\n]/.test(value) ? normalize(value) : undefined;
const version = value => typeof value === 'string' && /^(?:OpenCode )?[0-9][A-Za-z0-9.+-]{0,60}$/.test(value) ? value : 'unavailable';
const fail = value => { throw Object.assign(new Error(value), { code: value }); };

// Read only structured output and numerical exit markers. Never inspect tool inputs,
// titles, arbitrary prose, native provider records, or command bodies.
function parseOutput(raw) {
  if (object(raw)) return raw;
  if (typeof raw !== 'string') return {};
  for (const candidate of [raw, raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)]) {
    try { const value = JSON.parse(candidate); if (object(value)) return value; } catch { /* Unknown output remains unreported. */ }
  }
  return {};
}
function resultData(output) {
  const outer = parseOutput(output);
  const inner = parseOutput(outer.stdout);
  return { outer, data: Object.keys(inner).length ? inner : outer };
}
function exitCode(state, outer) {
  for (const value of [outer.exitCode, outer.exit, state.metadata?.exitCode, state.metadata?.exit]) if (integer(value) && value <= 255) return value;
  const marker = typeof state.output === 'string' ? state.output.match(/(?:^|\n)(?:Process exited with code|Exit code:)\s*(\d{1,3})(?:\s|$)/i) : null;
  return marker && Number(marker[1]) <= 255 ? Number(marker[1]) : undefined;
}
function classify(native, value, exit) {
  if ((exit !== undefined && exit !== 0) || value.ok === false || value.error || native === 'error' || native === 'failed' || value.status === 'restart-required') return 'failed';
  if (['pending', 'running', 'awaiting-approval', 'verifying', 'login-required'].includes(native) || ['awaiting-approval', 'verifying', 'login-required', 'in-progress'].includes(value.status)) return 'pending';
  return native === 'completed' || value.ok === true || value.status === 'ready' ? 'completed' : 'unavailable';
}
function details(value) {
  const result = [];
  for (const field of ['operation', 'meeting', 'page', 'chunk', 'chunks']) {
    const v = integer(value[field]) ? value[field] : id(value[field]);
    if (v !== undefined) result.push(`${field}=${v}`);
  }
  for (const field of ['inputBytes', 'captureMs', 'loginMs']) if (number(value[field])) result.push(`${field}=${value[field]}`);
  if (['ready', 'login-required', 'awaiting-approval', 'login-failed', 'in-progress', 'visible-complete', 'restart-required'].includes(value.status)) result.push(`status=${value.status}`);
  const context = value.context ?? value;
  if (typeof context.profile === 'string' && /^tinychat-agent(?:-\d+)?$/.test(context.profile)) result.push(`profile=${context.profile}`);
  if (id(context.space)) result.push(`space=${context.space}`);
  if (value.status && object(value.access)) result.push('accessEvidence=historical');
  if (value.access === 'not-tested') result.push('access=not-tested');
  if (['remote-acquisition', 'local-historical'].includes(value.acquisition?.mode)) result.push(`acquisition=${value.acquisition.mode}`);
  if (['selected', 'empty', 'no-dated-meeting'].includes(value.selection?.status)) result.push(`selection=${value.selection.status}`);
  for (const field of ['meetingListings', 'transcriptSegments', 'remoteBodyAcquisitions', 'remoteBodyBytes', 'outputPages', 'localDisplayChunks', 'localReviewsCompleted']) if (integer(value.counts?.[field])) result.push(`${field}=${value.counts[field]}`);
  for (const field of ['authenticated', 'sqlRead', 'bodyRead', 'currentAuthorityVerified', 'currentBodyRevisionVerified']) if (typeof value.access?.[field] === 'boolean') result.push(`${field}=${value.access[field]}`);
  for (const source of [value.coverage, value.progress, value]) for (const field of coverageFields) {
    const v = source?.[field];
    if (typeof v === 'boolean' || number(v) || v === 'unknown') result.push(`${field}=${v}`);
  }
  if (typeof value.morePages === 'boolean') result.push(`morePages=${value.morePages}`);
  const bodyHash = value.provenance?.bodySha256;
  if (typeof bodyHash === 'string' && /^[a-f0-9]{64}$/.test(bodyHash)) result.push(`bodySha256=${bodyHash}`);
  for (const field of ['path', 'artifactDirectory']) if (path(value[field])) result.push(`local=${path(value[field])}`);
  if (code(value.lastError?.code)) result.push(`lastError=${code(value.lastError.code)}`);
  return [...new Set(result)];
}
function references(value) {
  const refs = [];
  const record = value.record ?? {};
  const reviewed = Array.isArray(value.reviews) ? value.reviews.flatMap(review => Array.isArray(review?.spans) ? review.spans : []) : [];
  for (const span of [...(Array.isArray(value.sources) ? value.sources : []), ...(Array.isArray(value.spans) ? value.spans : []), ...reviewed]) {
    if (!object(span) || !integer(span.recordIndex) || !integer(span.start) || !integer(span.end) || span.end < span.start) continue;
    const parts = [];
    for (const [label, v] of [['source', record.source], ['sourceId', record.sourceId], ['recordId', span.recordId ?? record.id]]) if (id(v)) parts.push(`${label}=${id(v)}`);
    parts.push(`recordIndex=${span.recordIndex}`, `UTF-16 ${span.start}–${span.end}`);
    if (span.speaker) parts.push(`speaker=${note(span.speaker)}`);
    if (number(span.startSecs)) parts.push(`timestamp=${span.startSecs}s`);
    refs.push(parts.join('; '));
  }
  return refs;
}

/** Render a strictly session-bound local diagnostic account. This is a projection
 * of known receipts and tool observations, never a conversation/history dump. */
export function buildSessionHandoff({ sessionID, messages = [], receipt, observations = [], goal, nextAction, versions = {}, timings = {} } = {}) {
  if (!id(sessionID) || !sessionID.startsWith('ses_') || !Array.isArray(messages) || !Array.isArray(observations)) fail('HANDOFF_SESSION_MISMATCH');
  const bound = value => { if (value?.sessionID !== sessionID) fail('HANDOFF_SESSION_MISMATCH'); };
  for (const message of messages) {
    bound(message?.info);
    if (!Array.isArray(message.parts)) fail('HANDOFF_SESSION_MISMATCH');
    for (const part of message.parts) bound(part);
  }
  if (receipt) bound(receipt);
  for (const observation of observations) bound(observation);
  const events = [], answerIds = [], models = new Set();
  function add(stage, native, value, reference, exit, durationMs) {
    events.push({ stage, native, value, reference: id(reference) ?? 'unavailable', exit, status: classify(native, value, exit), durationMs });
  }
  if (receipt) add('auth', receipt.status, receipt, 'signin-receipt');
  for (const message of messages) {
    const model = message.info.model ?? message.info;
    if (id(model.providerID) && id(model.modelID)) models.add(`${model.providerID}/${model.modelID}`);
    for (const part of message.parts) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.startsWith('TinyChat sign-in receipt: ')) {
        const value = parseOutput(part.text.slice('TinyChat sign-in receipt: '.length));
        add('auth', value.status, value, part.id);
      } else if (part.type === 'text' && message.info.role === 'assistant' && !part.synthetic && id(part.id)) answerIds.push(part.id);
      if (part.type !== 'tool') continue;
      const native = ['completed', 'pending', 'running', 'error'].includes(part.state?.status) ? part.state.status : 'unavailable';
      const state = part.state ?? {};
      const known = knownTools.has(part.tool);
      const { outer, data } = known ? resultData(state.output) : { outer: {}, data: {} };
      const stage = code(data.error?.code) === 'UPLOAD_AUTH_REQUIRED' ? 'export' : ['diagnostics', 'discovery'].includes(data.stage) ? data.stage : part.tool === 'tinychat_meetings' && Array.isArray(data.meetings) ? 'discovery' : (Object.hasOwn(commands, data.command) ? commands[data.command] : Object.hasOwn(toolStages, part.tool) ? toolStages[part.tool] : 'tool');
      const elapsed = number(state.time?.start) && number(state.time?.end) && state.time.end >= state.time.start ? state.time.end - state.time.start : undefined;
      add(stage, native, data, part.id, exitCode(known ? state : {}, outer), elapsed);
      if (part.tool === 'tinychat_meetings' && stage === 'discovery' && !data.acquisition && ['authenticated', 'sqlRead', 'bodyRead'].every(field => typeof data.access?.[field] === 'boolean')) {
        add('diagnostics', native, { ok: ['authenticated', 'sqlRead', 'bodyRead'].every(field => data.access[field]), access: data.access, cliVersion: data.cliVersion }, part.id);
      }
    }
  }
  for (const observation of observations) add(stages.has(observation.stage) ? observation.stage : 'tool', ['completed', 'failed', 'pending'].includes(observation.status) ? observation.status : 'unavailable', observation, observation.id ?? observation.operation, integer(observation.exitCode) ? observation.exitCode : undefined, number(observation.durationMs) ? observation.durationMs : undefined);
  const observedCliVersions = [...new Set(events.map(event => version(event.value.cliVersion)).filter(value => value !== 'unavailable'))];
  const lines = [
    '# Local diagnostic handoff', '',
    `User goal: ${note(goal ?? 'Review the TinyChat session outcome and meeting evidence.')}`, '',
    `Session: ${sessionID}`, `Client: ${version(versions.client ?? (versions.opencode ? 'OpenCode ' + versions.opencode : undefined))}`, `Model observed: ${[...models].join(', ') || 'unavailable'}`,
    `Installed candidate: ${version(versions.candidate)}`, `CLI version: ${version(versions.cli) !== 'unavailable' ? version(versions.cli) : observedCliVersions.join(', ') || 'unavailable'}`, '',
    '## Stages and material failures', '',
  ];
  for (const event of events) {
    const fields = [`${event.reference}: ${event.stage} ${event.status}`, `native ${['completed', 'pending', 'running', 'error', 'failed', 'ready', 'awaiting-approval', 'login-required', 'login-failed'].includes(event.native) ? event.native : 'unavailable'}`];
    if (event.exit !== undefined) fields.push(`exit ${event.exit}`);
    if (code(event.value.error?.code)) fields.push(code(event.value.error.code));
    if (number(event.durationMs)) fields.push(`tool elapsed ${event.durationMs} ms`);
    fields.push(...details(event.value));
    lines.push('- ' + fields.join('; '));
  }
  if (!events.length) lines.push('No safe stage observations available.');
  for (const stage of ['auth', 'context', 'diagnostics', 'retrieval']) if (!events.some(event => event.stage === stage)) lines.push(`- ${stage}: unavailable; not established by this export.`);
  const operationTimings = new Map();
  for (const event of events) if (id(event.value.operation) && object(event.value.timings)) operationTimings.set(event.value.operation, event.value.timings);
  lines.push('', '## Timings', '', 'Independently measured values; unavailable values are not inferred from total session time.');
  if (operationTimings.size) lines.push('Consumer subprocess timings use the latest cumulative snapshot per operation, including failed attempts; saved display retries do not add retrieval time.');
  for (const [field, label] of [['installMs', 'install'], ['modelWaitMs', 'model wait'], ['orchestrationMs', 'orchestration'], ['captureMs', 'capture'], ['loginMs', 'login'], ['retrievalMs', 'retrieval'], ['diagnosticsMs', 'diagnostics subprocess'], ['discoveryMs', 'discovery subprocess']]) {
    const measured = ['retrievalMs', 'diagnosticsMs', 'discoveryMs'].includes(field) ? [...operationTimings.values()].map(value => value[field]).filter(number) : [];
    const total = measured.reduce((sum, value) => sum + value, 0);
    const samples = number(timings[field]) ? [timings[field]] : measured.length && number(total) ? [total] : ['captureMs', 'loginMs'].includes(field) ? events.filter(event => event.stage === 'auth' && number(event.value[field])).map(event => event.value[field]) : [];
    lines.push(`- ${label}: ${samples.length ? [...new Set(samples)].map(value => `${value} ms`).join(', ') : 'unavailable'}`);
  }
  lines.push('', '## Answer and evidence references', '', `Native answer parts (content omitted): ${[...new Set(answerIds)].join(', ') || 'unavailable'}`);
  const refs = events.flatMap(event => references(event.value).map(ref => `${event.reference}: ${ref}`));
  lines.push(...[...new Set(refs)].map(ref => '- ' + ref));
  if (!refs.length) lines.push('No safe span references available; inspect the named native tool parts or local operation artifacts.');
  const reverse = [...events].reverse();
  const latestRetrieval = reverse.find(event => event.stage === 'retrieval');
  const latestConsumer = reverse.find(event => ['diagnostics', 'discovery', 'retrieval'].includes(event.stage));
  const nodeUnavailable = (latestConsumer?.value.error?.code ?? latestConsumer?.value.lastError?.code) === 'NODE_UNAVAILABLE';
  const latestCoverage = reverse.find(event => typeof (event.value.coverage?.visibleComplete ?? event.value.progress?.visibleComplete ?? event.value.visibleComplete) === 'boolean');
  const revisionChanged = (latestRetrieval?.value.error?.code ?? latestRetrieval?.value.lastError?.code) === 'REVISION_CHANGED';
  const complete = !revisionChanged && (latestCoverage?.value.coverage?.visibleComplete ?? latestCoverage?.value.progress?.visibleComplete ?? latestCoverage?.value.visibleComplete);
  const latestAuth = reverse.find(event => event.stage === 'auth');
  const hasTraversal = events.some(event => event.stage === 'retrieval' && id(event.value.operation));
  const defaultNextAction = nodeUnavailable ? 'Restore Node.js 20 or later on the client PATH, then retry the same saved operation; keep the selected TinyCloud profile and authorization.'
    : revisionChanged ? 'Start an explicit clean traversal of the same intended meeting after REVISION_CHANGED; do not combine body revisions.'
    : !hasTraversal && latestAuth?.status === 'pending' ? 'Complete the existing pending sign-in, then select and acquire the intended meeting to verify actual SQL/body access.'
      : !hasTraversal && latestAuth?.status === 'failed' ? 'Resolve the recorded sign-in failure for the selected profile, then acquire the intended meeting to verify actual SQL/body access.'
        : !hasTraversal ? 'Verify setup, then select and acquire the intended meeting to verify actual SQL/body access.'
          : complete ? 'Review each answer claim and named speaker against its cited evidence; retain this local handoff for the next agent.'
            : 'Resume the intended saved operation, read remaining chunks and answer with their direct references.';
  lines.push('', '## Coverage, quality and next action', '',
    complete === true ? 'The latest reported traversal records complete evidence delivery. The installed client confirms exact untruncated tool outputs at its model-input boundary; older acknowledgment records need separate client evidence.' : 'Pending: read remaining saved evidence; complete model-input delivery is not established.',
    'A saved body or returned payload alone does not prove complete model-input delivery; this does not establish model attention or semantic understanding. Catalog coverage remains limited to the observed supported sources; describe a last observed meeting accordingly.',
    'Local historical evidence does not recheck current remote authority, source identity or body revision. Remote acquisition counts count KV attempts and any explicitly requested diagnostics probe; byte counts are observed output bytes. The compact recap path uses only its selected acquisition. Transcript segments are records within a meeting, not additional meetings.',
    'Semantic claim support and named-speaker attribution require review against the cited spans. Split combined claims and distinguish proposals, preferences, decisions and commitments.',
    `Next action: ${nextAction === undefined ? defaultNextAction : note(nextAction)}`,
    '', 'This artifact stays local. No raw messages, command bodies, provider records, signed authorization responses, private keys or TUI input history are included.', 'Known client limit: OpenCode TUI input history may retain pasted text locally; this export does not inspect or change it.', '');
  return lines.join('\n');
}

export async function exportSessionHandoff(options = {}) {
  const outputPath = options.outputPath;
  if (!path(outputPath)) fail('HANDOFF_PATH_INVALID');
  const markdown = buildSessionHandoff(options);
  try { await writeFile(outputPath, markdown, { flag: 'wx', mode: 0o600 }); }
  catch (error) { fail(error.code === 'EEXIST' ? 'HANDOFF_PATH_EXISTS' : 'HANDOFF_WRITE_FAILED'); }
  return { ok: true, status: 'exported', sessionID: options.sessionID, path: normalize(outputPath) };
}
