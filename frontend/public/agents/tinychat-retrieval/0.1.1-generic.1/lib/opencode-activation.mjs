import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, realpath, open, link, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

const exec = promisify(execFile);
const lifetime = 120_000;
const failure = (suffix, message) => Object.assign(new Error(message), { code: `OPENCODE_ACTIVATION_${suffix}` });

function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw failure('INVALID', `${label} must be an absolute path.`);
  return value;
}

export function activationRoot(env = process.env) {
  const home = absolute(env.HOME, 'HOME');
  return join(absolute(env.XDG_STATE_HOME || join(home, '.local/state'), 'XDG_STATE_HOME'), 'tinychat-retrieval/opencode-activation');
}

async function processInfo(pid) {
  const read = async field => (await exec('/bin/ps', ['-p', String(pid), '-o', `${field}=`], { timeout: 3000, maxBuffer: 32_768 })).stdout.trim();
  const [parent, executable, args] = await Promise.all([read('ppid'), read('comm'), read('args')]);
  return { parentPID: Number(parent), executable, args };
}

async function getVersion(executable, env) {
  return (await exec(executable, ['--version'], { env, timeout: 5000, maxBuffer: 1024 })).stdout.trim();
}

function directTui(args, executable, directory) {
  if (typeof args !== 'string' || !isAbsolute(executable) || basename(executable) !== 'opencode') return false;
  const first = args.match(/^\S+/)?.[0];
  if (!first || basename(first) !== 'opencode') return false;
  let rest = args.slice(first.length).trim();
  // ps cannot recover argv boundaries. Accept an exact absolute project prefix
  // and simple known flags; reject --prompt and ambiguous positional arguments.
  if (rest === directory) rest = '';
  else if (rest.startsWith(directory + ' ')) rest = rest.slice(directory.length).trim();
  const values = new Set(['--model', '-m', '--agent', '--session', '-s', '--hostname', '--port', '--log-level', '--mdns-domain']);
  const flags = new Set(['--continue', '-c', '--fork', '--auto', '--print-logs', '--mdns', '--no-mdns']);
  const tokens = rest ? rest.split(/\s+/) : [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (flags.has(token)) continue;
    const equal = token.indexOf('=');
    if (equal > 0 && values.has(token.slice(0, equal)) && token.slice(equal + 1) && !token.slice(equal + 1).startsWith('-')) continue;
    if (!values.has(token) || !tokens[index + 1] || tokens[++index].startsWith('-')) return false;
  }
  return true;
}

const bindingSql = `
  SELECT p.id AS partID, p.message_id AS messageID, p.session_id AS sessionID,
    json_extract(m.data, '$.parentID') AS userMessageID,
    json_extract(m.data, '$.agent') AS agent,
    json_extract(m.data, '$.providerID') AS providerID,
    json_extract(m.data, '$.modelID') AS modelID,
    json_extract(m.data, '$.variant') AS variant
  FROM part p JOIN session s ON s.id=p.session_id
    JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id
    JOIN message u ON u.id=json_extract(m.data, '$.parentID') AND u.session_id=p.session_id
  WHERE s.directory=? AND p.time_updated>=?
    AND json_extract(m.data, '$.role')='assistant' AND json_extract(u.data, '$.role')='user'
    AND json_extract(p.data, '$.type')='tool' AND json_extract(p.data, '$.tool')='bash'
    AND json_extract(p.data, '$.state.status')='running'
    AND instr(json_extract(p.data, '$.state.metadata.output'), ?)>0
  LIMIT 2`;

function validateDescriptor(descriptor, now) {
  const validID = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
  if (!descriptor || descriptor.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(descriptor.nonce || '') ||
      descriptor.marker !== `TINYCHAT_ACTIVATION:${descriptor.nonce}` ||
      !validID(descriptor.sessionID, 'ses') || !validID(descriptor.messageID, 'msg') ||
      !validID(descriptor.userMessageID, 'msg') || !validID(descriptor.partID, 'prt') ||
      !Number.isSafeInteger(descriptor.hostPID) || descriptor.hostPID <= 1 ||
      !Number.isSafeInteger(descriptor.createdAt) || descriptor.createdAt > now ||
      descriptor.expiresAt !== descriptor.createdAt + lifetime || descriptor.expiresAt <= now ||
      !descriptor.agent || typeof descriptor.agent !== 'string' ||
      !descriptor.model?.providerID || typeof descriptor.model.providerID !== 'string' ||
      !descriptor.model?.modelID || typeof descriptor.model.modelID !== 'string' ||
      (descriptor.variant !== undefined && (typeof descriptor.variant !== 'string' || !descriptor.variant)) ||
      (descriptor.integrationVersion !== undefined && (typeof descriptor.integrationVersion !== 'string' || !descriptor.integrationVersion))) {
    throw failure('INVALID', 'The one-time OpenCode activation descriptor is invalid or expired.');
  }
  absolute(descriptor.directory, 'directory');
}

/** Pinned, single-conversation macOS TUI trial. This does not signal or write. */
export async function prepareActivation({
  env = process.env, directory = process.cwd(), integrationVersion,
  platform = process.platform, nodeVersion = process.versions.node, parentPID = process.ppid,
  processInfo: inspect = processInfo, getVersion: version = getVersion,
  now = Date.now, nonce = randomBytes(32).toString('hex'), timeoutMs = 3000,
  emitMarker = marker => new Promise((resolve, reject) => process.stdout.write(marker + '\n', error => error ? reject(error) : resolve())),
} = {}) {
  activationRoot(env);
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (platform !== 'darwin' || !(major > 22 || (major === 22 && minor >= 20)) || env.OPENCODE !== '1' ||
      !/^[1-9][0-9]*$/.test(env.OPENCODE_PID || '') || env.OPENCODE_DB !== undefined ||
      (env.OPENCODE_PURE && !['0', 'false'].includes(env.OPENCODE_PURE)) || !/^[a-f0-9]{64}$/.test(nonce)) {
    throw failure('UNSUPPORTED', 'Automatic activation requires the pinned local macOS OpenCode TUI, Node 22.20+, and its default file database.');
  }
  const hostPID = Number(env.OPENCODE_PID);
  if (!Number.isSafeInteger(hostPID) || hostPID <= 1) throw failure('INVALID', 'Invalid OpenCode host PID.');
  directory = await realpath(absolute(directory, 'directory'));
  let ancestor = parentPID;
  for (let depth = 0; ancestor !== hostPID && ancestor > 1 && depth < 32; depth++) {
    const parent = (await inspect(ancestor)).parentPID;
    if (!Number.isSafeInteger(parent) || parent === ancestor) break;
    ancestor = parent;
  }
  if (ancestor !== hostPID) throw failure('UNSUPPORTED', 'OpenCode host PID is not an ancestor of this installer.');
  const host = await inspect(hostPID);
  if (!directTui(host.args, host.executable, directory) || await version(host.executable, env) !== '1.18.31') {
    throw failure('UNSUPPORTED', 'Automatic activation supports only an unambiguous direct OpenCode 1.18.31 TUI invocation.');
  }
  const dbPath = join(absolute(env.XDG_DATA_HOME || join(env.HOME, '.local/share'), 'XDG_DATA_HOME'), 'opencode/opencode.db');
  const info = await lstat(dbPath);
  if (!info.isFile() || info.isSymbolicLink()) throw failure('INVALID', 'OpenCode database must be a regular local file.');
  // Dynamic import keeps older Node runtimes usable for installation without activation.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true, enableExtensions: false });
  const createdAt = now();
  const marker = `TINYCHAT_ACTIVATION:${nonce}`;
  try {
    await emitMarker(marker);
    const query = db.prepare(bindingSql);
    const deadline = performance.now() + Math.max(0, Math.min(timeoutMs, 5000));
    let matches;
    do {
      matches = query.all(directory, createdAt - 5000, marker);
      if (matches.length) break;
      if (performance.now() >= deadline) throw failure('SESSION_NOT_FOUND', 'The installer could not bind its marker to a running native OpenCode bash tool.');
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (true);
    if (matches.length !== 1) throw failure('SESSION_AMBIGUOUS', 'The installer marker matched more than one OpenCode tool; activation was not requested.');
    const match = matches[0];
    // Conservative evidence check only: the database does not identify host PIDs
    // or lock out new work. The supported trial still requires no parallel work.
    const otherAssistant = db.prepare("SELECT 1 FROM message WHERE id<>? AND json_extract(data,'$.role')='assistant' AND json_extract(data,'$.time.completed') IS NULL LIMIT 1").get(match.messageID);
    const otherTool = db.prepare("SELECT 1 FROM part WHERE id<>? AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.state.status') IN ('running','pending') LIMIT 1").get(match.partID);
    if (otherAssistant || otherTool) throw failure('CONCURRENT_WORK', 'Another unfinished OpenCode assistant or tool exists. Automatic activation is limited to a single conversation without background work.');
    const descriptor = {
      schemaVersion: 1, nonce, marker, sessionID: match.sessionID, messageID: match.messageID, partID: match.partID,
      userMessageID: match.userMessageID, agent: match.agent, model: { providerID: match.providerID, modelID: match.modelID },
      ...(typeof match.variant === 'string' && match.variant ? { variant: match.variant } : {}),
      directory, hostPID, createdAt, expiresAt: createdAt + lifetime,
      ...(integrationVersion === undefined ? {} : { integrationVersion }),
    };
    validateDescriptor(descriptor, now());
    return descriptor;
  } finally {
    db.close();
  }
}

/** Publish once with mode 0600. The caller requests native reload afterwards. */
export async function writeActivation(descriptor, { env = process.env, now = Date.now } = {}) {
  validateDescriptor(descriptor, now());
  const root = activationRoot(env);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw failure('INVALID', 'Activation directory must be a private regular directory.');
  const path = join(root, `${descriptor.hostPID}.json`);
  const temporary = join(root, `.${descriptor.hostPID}.${randomBytes(8).toString('hex')}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(descriptor) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    // link is atomic and, unlike rename, cannot replace a pending descriptor.
    await link(temporary, path);
  } catch (error) {
    if (error.code === 'EEXIST') throw failure('PENDING', 'An OpenCode activation request already exists for this host; it was left intact.');
    throw error;
  } finally {
    await unlink(temporary);
  }
  return path;
}
