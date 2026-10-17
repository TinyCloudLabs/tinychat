import { createHash, randomUUID } from 'node:crypto';
import { rm, rmdir, readFile, mkdir } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSetup } from './setup.mjs';
import { DISPLAY_BYTES } from './consumer.mjs';
import { resumeActivation } from './opencode-continuation.mjs';

const prompt = 'Complete sign-in in the browser, then paste the code here.';
const knownErrors = new Set(['INVALID_AUTH_RESPONSE', 'AUTH_RESPONSE_REJECTED', 'OPENKEY_PROOF_INVALID', 'OWNER_MISMATCH', 'OPENKEY_SCOPE_MISMATCH', 'OPENKEY_GRANT_BROADENED', 'AUTH_EXPIRED', 'AUTH_TRANSPORT_TIMEOUT', 'CLI_UNAVAILABLE', 'SETUP_CONFIG_REQUIRED', 'SETUP_CONFIG_INVALID', 'CONTEXT_MISMATCH', 'INVALID_RESPONSE', 'CLI_VERSION', 'APPROVAL_CONTEXT_CHANGED']);
const failure = code => ({ ok: false, status: 'login-failed', error: { code, message: 'Sign-in was not completed. Keep the selected profile; use this error code to resolve the failure.' } });
const safeError = error => failure(knownErrors.has(error?.code) ? error.code : 'SIGNIN_FAILED');
const binding = value => JSON.stringify([value.profile, value.host, value.sessionDid, value.loginArgs]);
const digest = text => createHash('sha256').update(text).digest('hex');
const responseLike = (text, awaiting) => {
  const trimmed = text.trimStart();
  if (awaiting) return trimmed.startsWith('{') || /^eyJ|^[A-Za-z0-9+/_=-]{32}/.test(trimmed);
  return /^eyJ[A-Za-z0-9+/_=-]{125}/.test(trimmed) || (trimmed.startsWith('{') && /\"(?:delegationHeader|authorization|signature|siwe)\"\s*:/.test(trimmed));
};
const stringify = value => JSON.stringify(value);

/** OpenCode 1.18.31 chat.message runs before persistence and before the model loop.
 * The accepted text goes directly to setup.login -> responseInput -> CLI stdin.
 * Neither model arguments nor a generated shell command ever carry the response.
 */
export function createSigninHooks({ setup }) {
  const pending = new Map();
  const receipts = new Map();
  const messages = new Map();
  const completed = new Map();
  const opening = new Set();
  const pendingReceipt = record => ({ ok: true, status: 'awaiting-approval', approvalId: record.id, profile: record.expectedContext.profile, delivery: record.delivery, instructions: prompt });
  function redact(parts, receipt) {
    const text = 'TinyChat sign-in receipt: ' + stringify(receipt);
    let first = true;
    for (const part of parts) if (part.type === 'text' && !part.synthetic) {
      part.text = first ? text : '[Additional authorization input withheld.]';
      first = false;
    }
  }
  return {
    tool: {
      tinychat_authorize: {
        description: 'Open TinyChat sign-in and bind the next pasted authorization response to this conversation and selected profile. Prepare app setup first. Never pass a code as an argument.',
        args: {},
        async execute(_args, { sessionID }) {
          if (!sessionID) return stringify(failure('CONVERSATION_REQUIRED'));
          if (pending.has(sessionID)) return stringify(pendingReceipt(pending.get(sessionID)));
          if (opening.size) return stringify(failure('AUTHORIZATION_IN_PROGRESS'));
          opening.add(sessionID);
          try {
            const expectedContext = await setup.context();
            if (expectedContext.status === 'ready') return stringify({ ok: true, ...expectedContext });
            if ([...pending.values()].some(record => record.expectedContext.profile === expectedContext.profile)) return stringify(failure('APPROVAL_IN_ANOTHER_SESSION'));
            const record = { id: randomUUID(), expectedContext, busy: false };
            try {
              const result = await setup.authorize();
              if (result.status === 'ready') return stringify({ ok: true, ...result });
              if (binding(result) !== binding(expectedContext)) return stringify(failure('APPROVAL_CONTEXT_CHANGED'));
              record.delivery = result.delivery;
            } catch (error) {
              if (error.code !== 'BROWSER_OPEN_FAILED' || !error.delivery) throw error;
              record.delivery = error.delivery;
              receipts.delete(sessionID);
              pending.set(sessionID, record);
              return stringify({ ...failure('BROWSER_OPEN_FAILED'), approvalId: record.id, delivery: record.delivery });
            }
            receipts.delete(sessionID);
            pending.set(sessionID, record);
            return stringify(pendingReceipt(record));
          } catch (error) { return stringify(safeError(error)); }
          finally { opening.delete(sessionID); }
        },
      },
      tinychat_signin_status: {
        description: 'Read this conversation’s TinyChat sign-in receipt. No credential arguments. The selected meeting acquisition will test actual SQL/body access.',
        args: {},
        async execute(_args, { sessionID }) {
          return stringify(receipts.get(sessionID) ?? (pending.has(sessionID) ? pendingReceipt(pending.get(sessionID)) : failure('NO_PENDING_APPROVAL')));
        },
      },
    },
    async 'chat.message'(input, output) {
      const captureStarted = performance.now();
      const capturedAt = new Date().toISOString();
      const parts = output.parts;
      const texts = parts.filter(part => part.type === 'text' && !part.synthetic && part.text.trim().length);
      const sessionID = input.sessionID;
      if (!texts.some(part => responseLike(part.text, pending.has(sessionID)))) return;
      const messageID = output.message.id;
      // Capture a reference to the original accepted string before changing the mutable part in place.
      const raw = texts.length === 1 ? texts[0].text : undefined;
      const hash = raw === undefined ? undefined : digest(raw);
      const key = `${sessionID}:${messageID}`;
      const record = pending.get(sessionID);
      let result;
      if (messages.has(key) || (hash && completed.get(sessionID)?.has(hash))) result = failure('DUPLICATE_AUTH_RESPONSE');
      else if (!messageID || output.message.sessionID !== sessionID) result = failure('CONVERSATION_MISMATCH');
      else if (!record) result = failure('NO_PENDING_APPROVAL');
      else if (texts.length !== 1 || parts.some(part => part.type !== 'text')) result = failure('AMBIGUOUS_AUTH_RESPONSE');
      else if (record.busy) result = failure('AUTH_CAPTURE_IN_PROGRESS');
      redact(parts, result ?? { ok: true, status: 'verifying', approvalId: record?.id });
      messages.set(key, true);
      const captureMs = Number((performance.now() - captureStarted).toFixed(3));
      if (!result) {
        record.busy = true;
        const started = performance.now();
        try {
          if (binding(await setup.context()) !== binding(record.expectedContext)) {
            result = failure('APPROVAL_CONTEXT_CHANGED');
          } else {
            const verified = await setup.login(raw, { expectedContext: record.expectedContext });
            if (verified.status !== 'ready') throw new Error('No verified context');
            result = { ok: true, ...verified, approvalId: record.id, inputBytes: Buffer.byteLength(raw), loginMs: Math.round(performance.now() - started) };
            pending.delete(sessionID);
            if (!completed.has(sessionID)) completed.set(sessionID, new Set());
            completed.get(sessionID).add(hash);
            // Only the artifact returned by this operation is eligible for cleanup. Never recursive.
            if (record.delivery?.artifactPath) {
              try {
                await rm(record.delivery.artifactPath);
                await rmdir(dirname(record.delivery.artifactPath));
              } catch { result.cleanup = 'approval-artifact-retained'; }
            }
          }
        } catch (error) {
          result = { ...safeError(error), approvalId: record.id, loginMs: Math.round(performance.now() - started) };
          if (error.code === 'AUTH_EXPIRED') pending.delete(sessionID);
        }
        finally { record.busy = false; }
      }
      result = { ...result, capturedAt, captureMs };
      receipts.set(sessionID, result);
      redact(parts, result);
    },
  };
}

const experienceFailure = code => ({ ok: false, exitCode: 1, error: { code, message: 'TinyChat operation failed. Preserve saved progress and inspect the classified code.' } });
const meetingKeys = new Set(['action', 'operation', 'meeting', 'page', 'chunk', 'retry', 'newOperation', 'term', 'source', 'from', 'to', 'limit']);

export function createExperienceHooks({ setup, consumer, client, outputDirectory, versions = {} }) {
  return {
    async config(config) {
      config.tool_output = { ...config.tool_output, max_bytes: Math.max(config.tool_output?.max_bytes ?? 0, DISPLAY_BYTES), max_lines: Math.max(config.tool_output?.max_lines ?? 0, 2000) };
    },
    async 'experimental.chat.messages.transform'(_input, output) {
      // This pinned-client hook runs after tool truncation/compaction and immediately
      // before model-message conversion. Do not count saved or compacted bodies.
      for (const message of output.messages) for (const part of message.parts) {
        if (message.info.role !== 'assistant' || message.info.error || part.type !== 'tool' || part.tool !== 'tinychat_meetings' || part.state?.status !== 'completed' ||
            part.state.metadata?.truncated !== false || part.state.time?.compacted || typeof part.state.output !== 'string') continue;
        let value; try { value = JSON.parse(part.state.output); } catch { continue; }
        if (!value.ok || !Array.isArray(value.spans) || !value.coverage || part.sessionID !== message.info.sessionID) continue;
        const delivery = await consumer.confirmDelivery(part.state.output, { sessionID: part.sessionID });
        if (delivery.ok) part.state.output = stringify({ ...value, coverage: { ...value.coverage, visibleComplete: delivery.visibleComplete, deliveredChunks: delivery.deliveredChunks } });
      }
    },
    tool: {
    tinychat_setup: {
      description: 'Prepare or reuse the installed TinyChat setup. Optional configPath is the app JSON file, never an authorization response. If login-required, use tinychat_authorize.',
      args: {},
      async execute(args, { sessionID }) {
        try {
          if (!sessionID || Object.keys(args).some(key => key !== 'configPath')) return stringify(experienceFailure('INVALID_INPUT'));
          if (args.configPath !== undefined && !isAbsolute(args.configPath)) return stringify(experienceFailure('INVALID_INPUT'));
          const config = args.configPath === undefined ? undefined : JSON.parse(await readFile(args.configPath, 'utf8'));
          return stringify({ ok: true, ...await setup.prepare({ config }) });
        } catch (error) { return stringify(experienceFailure(knownErrors.has(error.code) ? error.code : 'SETUP_FAILED')); }
      },
    },
    tinychat_meetings: {
      description: 'For last/latest requests, use latest with a short operation: select the newest supported dated meeting, acquire once and return exact evidence with references. Answer directly from the spans and cite their ref with meeting title, observed speaker and timestamp. Check every substantive claim against that text; questions, proposals and commitments differ. Unknown speakers cannot support named attribution; generated notes are not verbatim speech. If nextAction is present, follow its numbered chunk for remaining evidence; identical input replays that chunk. No final acknowledgment, review or status call is needed. Returned evidence is not automatically proof of delivery: the client records only exact untruncated results on the model-input path. Partial evidence remains partial. discover paginates browsing and literal metadata term matching; read selects a saved meeting. Do not substitute an older meeting when latest is unavailable or dates are missing. Local evidence is historical: it does not recheck remote authority or revision. restart freshly acquires the same meeting in a new operation; a new latest reselects. Run actions sequentially. No opaque references, cursors or caller transcript text.',
      args: {},
      async execute(args, { sessionID }) {
        if (!sessionID || Object.keys(args).some(key => !meetingKeys.has(key)) || !['latest', 'discover', 'read', 'next', 'status', 'restart'].includes(args.action)) return stringify(experienceFailure('INVALID_INPUT'));
        const { action, ...input } = args;
        try { return stringify(await consumer.invoke(action, input, { sessionID })); }
        catch { return stringify(experienceFailure('CONSUMER_FAILED')); }
      },
    },
    tinychat_handoff: {
      description: 'Export this current session as a private local diagnostic Markdown handoff. Optional goal and nextAction are short original-task and unresolved-quality notes; never paste raw messages or commands. Records sanitized auth, errors, timings, coverage and native evidence IDs. No upload, share publishing, extra sign-in or scope changes. Returns an absolute local path.',
      args: {},
      async execute(args, { sessionID }) {
        if (!sessionID) return stringify(experienceFailure('CONVERSATION_REQUIRED'));
        if (Object.keys(args).some(key => !['goal', 'nextAction'].includes(key)) || Object.values(args).some(value => value !== undefined && (typeof value !== 'string' || value.length > 600))) return stringify(experienceFailure('INVALID_INPUT'));
        try {
          const result = await client.session.messages({ path: { id: sessionID } });
          if (result.error || !Array.isArray(result.data)) return stringify(experienceFailure('SESSION_READ_FAILED'));
          const { exportSessionHandoff } = await import('./session-handoff.mjs');
          const observations = consumer?.diagnostics ? await consumer.diagnostics({ sessionID }) : [];
          await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
          return stringify(await exportSessionHandoff({ sessionID, messages: result.data, versions, observations,
            goal: args.goal ?? 'Unavailable: no safe note of the original user goal was supplied.', nextAction: args.nextAction,
            outputPath: join(outputDirectory, `tinychat-session-${randomUUID()}.md`) }));
        } catch { return stringify(experienceFailure('LOCAL_EXPORT_FAILED')); }
      },
    },
  } };
}

export default async function TinyChatSignin({ client, directory } = {}, { schema } = {}) {
  if (!process.env.HOME) throw new Error('TinyChat sign-in requires HOME.');
  if (!schema) throw new Error('Re-run the installed OpenCode adapter installer and restart OpenCode.');
  const setup = createSetup({
    statePath: join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'tinychat-retrieval/setup.json'),
    manifestPath: fileURLToPath(new URL('../assets/permissions.json', import.meta.url)),
  });
  const packRoot = fileURLToPath(new URL('../', import.meta.url));
  const pack = JSON.parse(await readFile(join(packRoot, 'pack.json'), 'utf8'));
  const root = join(process.env.XDG_STATE_HOME || join(process.env.HOME, '.local/state'), 'tinychat-retrieval');
  const { createConsumer } = await import('./consumer.mjs');
  const experience = createExperienceHooks({ setup, consumer: createConsumer({ setup, root: join(root, 'operations'), packRoot, projectRoot: directory }), client,
    outputDirectory: join(root, 'handoffs'), versions: { candidate: pack.version, opencode: '1.18.31' } });
  experience.tool.tinychat_handoff.args = { goal: schema.string().max(600).optional(), nextAction: schema.string().max(600).optional() };
  experience.tool.tinychat_setup.args = { configPath: schema.string().optional() };
  experience.tool.tinychat_meetings.args = {
    action: schema.enum(['latest', 'discover', 'read', 'next', 'status', 'restart']), operation: schema.string(),
    meeting: schema.number().int().positive().optional(), page: schema.number().int().positive().optional(), chunk: schema.number().int().positive().optional(),
    retry: schema.boolean().optional(), newOperation: schema.string().optional(),
    term: schema.string().optional(), source: schema.string().optional(), from: schema.string().optional(), to: schema.string().optional(), limit: schema.number().int().positive().max(10).optional(),
  };
  const signin = createSigninHooks({ setup });
  // Return hooks before using the SDK: its tool registry waits for this initializer.
  setTimeout(() => {
    void resumeActivation({ client, directory, version: pack.version }).then(async result => {
      if (result.status === 'failed') await client.tui.showToast({ body: { title: 'TinyCloud setup paused', message: `Automatic continuation failed (${result.code}). Sign-in has not started.`, variant: 'error', duration: 15000 } });
    }).catch(() => { console.error('TinyCloud automatic continuation failed (CONTINUATION_FAILED).'); });
  }, 0);
  return { ...signin, ...experience, tool: { ...signin.tool, ...experience.tool },
    'shell.env': async (_input, output) => { output.env.TINYCHAT_OPENCODE_PLUGIN = pack.version; },
  };
}
