#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSetup } from '../lib/setup.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' }, 'code-file': { type: 'string' }, delivery: { type: 'string' }, 'new-profile': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('TinyChat setup: prepare [--config APP_JSON] [--new-profile] | authorize [--delivery browser|file] | login --code-file ABS_PRIVATE_FILE | context\nFor local macOS OpenCode 1.18.31 with Node >=22.20, install the CLI and both skills, then run node PACK/scripts/install-opencode.mjs --activate as the last, separate native bash call. The same conversation resumes automatically; use loaded tinychat_setup and tinychat_authorize. See references/setup.md for supported direct-TUI launches. Stop on a classified activation error. Standalone setup commands are unavailable inside OpenCode. The plugin owns capture; do not write the response through model tool arguments.\nprepare preserves the selected app profile. authorize opens the exact approval URL on this machine and returns a private HTML file path, with no process waiting for consent.\nFor remote/headless agents use authorize --delivery file, download the complete artifact to your machine and open it there. It lasts until deleted or temporary storage is cleared. Never transcribe its embedded URL.\nlogin --code-file is a setup.mjs option, not a tc auth login option. It reads complete JSON/base64 JSON from a mode-0600 file and sends it only through CLI stdin for verification. Remove only your temporary files afterward; preserve the login exit status.\ncontext returns verified primary owner/profile/host/resolved space and retrievalArgs; access remains not-tested.\n--new-profile is only for an intentional account/deployment change and preserves old CLI profiles.');
  } else {
    const command = positionals[0];
    if (!['prepare', 'context', 'authorize', 'login'].includes(command) || positionals.length !== 1 || (command !== 'prepare' && (values.config || values['new-profile'])) || (command === 'login') !== Boolean(values['code-file'])) throw new Error('Use --help for supported setup commands.');
    if (values.delivery !== undefined && (command !== 'authorize' || !['browser', 'file'].includes(values.delivery))) throw new Error('Use authorize --delivery browser or file.');
    // OpenCode sets this in its CLI and passes it to shell tools. Its plugin
    // calls the library directly; the portable helper cannot bind chat capture.
    if (process.env.OPENCODE === '1') throw Object.assign(new Error('In OpenCode, use tinychat_setup and tinychat_authorize. If these tools are missing, follow references/setup.md: on supported local macOS OpenCode 1.18.31 with Node >=22.20, install the CLI and both skills, then run node PACK/scripts/install-opencode.mjs --activate as the last, separate native bash call. The conversation resumes automatically. Stop on a classified activation error. Do not request or paste an authorization response before the tools are loaded. The standalone helper cannot bind OpenCode chat capture.'), { code: 'OPENCODE_TOOLS_REQUIRED' });
    if (!process.env.HOME) throw new Error('Terminal HOME is required to save the selected app profile.');
    const statePath = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'tinychat-retrieval/setup.json');
    const setup = createSetup({ statePath, manifestPath: fileURLToPath(new URL('../assets/permissions.json', import.meta.url)) });
    let result;
    if (command === 'login') {
      const path = values['code-file'];
      const info = await stat(path);
      if (!isAbsolute(path) || !info.isFile() || info.size > 1024 * 1024 || (info.mode & 0o077)) throw new Error('Code file must be an absolute private file no larger than 1 MiB.');
      result = await setup.login(await readFile(path, 'utf8'));
    } else if (command === 'authorize') result = await setup.authorize({ delivery: values.delivery });
    else if (command === 'context') result = await setup.context();
    else result = await setup.prepare({ config: values.config ? JSON.parse(await readFile(values.config, 'utf8')) : undefined, newProfile: values['new-profile'] });
    console.log(JSON.stringify({ ok: true, ...result }));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: { code: error.code ?? 'SETUP_ERROR', message: error.code ? error.message : 'Setup failed. Check the app configuration file and --help; no alternate account was selected.' }, ...(error.code === 'BROWSER_OPEN_FAILED' ? { delivery: error.delivery } : {}) }));
  process.exitCode = 1;
}
