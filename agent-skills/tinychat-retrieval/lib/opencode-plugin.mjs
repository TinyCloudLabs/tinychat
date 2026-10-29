import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSetup } from './setup.mjs';
import { DISPLAY_BYTES } from './consumer.mjs';
import { resumeActivation } from './opencode-continuation.mjs';

const knownErrors = new Set(['INVALID_AUTH_RESPONSE', 'AUTH_RESPONSE_REJECTED', 'OPENKEY_PROOF_INVALID', 'OWNER_MISMATCH', 'OPENKEY_SCOPE_MISMATCH', 'OPENKEY_GRANT_BROADENED', 'AUTH_EXPIRED', 'AUTH_TRANSPORT_TIMEOUT', 'CLI_UNAVAILABLE', 'SETUP_CONFIG_REQUIRED', 'SETUP_CONFIG_INVALID', 'CONTEXT_MISMATCH', 'INVALID_RESPONSE', 'CLI_VERSION']);
const failure = (code, message) => ({ ok: false, status: 'login-failed', error: { code, message: message ?? 'Sign-in was not completed. Keep the selected profile; use this error code to resolve the failure.' } });
const safeError = error => knownErrors.has(error?.code) ? failure(error.code, error.message) : failure('SIGNIN_FAILED');
const stringify = value => JSON.stringify(value);

/** The same paste path as setup.mjs: the agent passes the owner's code as sent. */
export function createSigninHooks({ setup }) {
  return {
    tool: {
      tinychat_authorize: {
        description: 'Ask once for TinyChat access when tinychat_setup reports access-required. Without code: returns approvalUrl and a one-line message; send both to the owner. When the owner sends back the code OpenKey shows, call again with code set to it exactly as sent.',
        args: {},
        async execute(args = {}) {
          if (Object.keys(args).some(key => key !== 'code') || (args.code !== undefined && typeof args.code !== 'string')) return stringify(failure('INVALID_INPUT'));
          try {
            return stringify({ ok: true, ...(args.code === undefined ? await setup.authorize() : await setup.login(args.code)) });
          } catch (error) { return stringify(safeError(error)); }
        },
      },
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
      description: 'Check the TinyCloud onboarding profile for TinyChat. Optional configPath is the app JSON file. ready: continue. onboarding-required: set up TinyCloud with https://agents.tinycloud.xyz/onboarding, then call again. access-required: use tinychat_authorize.',
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
  });
  const packRoot = fileURLToPath(new URL('../', import.meta.url));
  const pack = JSON.parse(await readFile(join(packRoot, 'pack.json'), 'utf8'));
  const root = join(process.env.XDG_STATE_HOME || join(process.env.HOME, '.local/state'), 'tinychat-retrieval');
  const { createConsumer } = await import('./consumer.mjs');
  const experience = createExperienceHooks({ setup, consumer: createConsumer({ setup, root: join(root, 'operations'), packRoot, projectRoot: directory }), client,
    outputDirectory: join(root, 'handoffs'), versions: { candidate: pack.version, opencode: '1.18.31' } });
  experience.tool.tinychat_handoff.args = { goal: schema.string().max(600).optional(), nextAction: schema.string().max(600).optional() };
  experience.tool.tinychat_setup.args = { configPath: schema.string().optional() };
  const signin = createSigninHooks({ setup });
  signin.tool.tinychat_authorize.args = { code: schema.string().optional() };
  experience.tool.tinychat_meetings.args = {
    action: schema.enum(['latest', 'discover', 'read', 'next', 'status', 'restart']), operation: schema.string(),
    meeting: schema.number().int().positive().optional(), page: schema.number().int().positive().optional(), chunk: schema.number().int().positive().optional(),
    retry: schema.boolean().optional(), newOperation: schema.string().optional(),
    term: schema.string().optional(), source: schema.string().optional(), from: schema.string().optional(), to: schema.string().optional(), limit: schema.number().int().positive().max(10).optional(),
  };
  // Return hooks before using the SDK: its tool registry waits for this initializer.
  setTimeout(() => {
    void resumeActivation({ client, directory, version: pack.version }).then(async result => {
      if (result.status === 'failed') await client.tui.showToast({ body: { title: 'TinyCloud setup paused', message: `Automatic continuation failed (${result.code}). Sign-in has not started.`, variant: 'error', duration: 15000 } });
    }).catch(() => { console.error('TinyCloud automatic continuation failed (CONTINUATION_FAILED).'); });
  }, 0);
  return { ...experience, tool: { ...signin.tool, ...experience.tool },
    'shell.env': async (_input, output) => { output.env.TINYCHAT_OPENCODE_PLUGIN = pack.version; },
  };
}
