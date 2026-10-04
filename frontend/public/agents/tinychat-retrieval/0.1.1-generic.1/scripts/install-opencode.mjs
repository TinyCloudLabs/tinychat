#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { prepareActivation, writeActivation } from '../lib/opencode-activation.mjs';

const marker = '// TinyChat sign-in adapter; managed by install-opencode.mjs\n';
try {
  const { values } = parseArgs({ options: { activate: { type: 'boolean', default: false } } });
  if (!process.env.HOME) throw new Error('HOME is required.');
  if (values.activate && process.env.OPENCODE !== '1') throw new Error('--activate must run inside the supported OpenCode conversation.');
  const checked = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
  if (checked.status !== 0 || checked.stdout.trim() !== '1.18.31') throw new Error('This adapter requires OpenCode 1.18.31.');
  const plugin = new URL('../lib/opencode-plugin.mjs', import.meta.url);
  const bytes = await readFile(plugin);
  const pack = JSON.parse(await readFile(new URL('../pack.json', import.meta.url), 'utf8'));
  const directory = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'opencode/plugins');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'tinychat-signin.js');
  const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || !(await readFile(path, 'utf8')).startsWith(marker))) throw new Error('An unmanaged tinychat-signin.js already exists; keep it intact and resolve the name conflict.');
  const alreadyLoaded = process.env.TINYCHAT_OPENCODE_PLUGIN === pack.version;
  let activation;
  if (values.activate && !alreadyLoaded) {
    // Probe imports in a fresh process: an incomplete cold install must not leave
    // a failed module cached in the long-lived OpenCode loader.
    const parent = join(directory, '..');
    const probe = "const m=await import('@opencode-ai/plugin'); if(typeof m.tool?.schema?.string!=='function')process.exit(1);";
    const started = Date.now();
    for (;;) {
      const ready = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], { cwd: parent, encoding: 'utf8', timeout: 3000 });
      if (ready.status === 0) break;
      if (Date.now() - started > 30000) throw new Error('OpenCode plugin dependencies did not become ready; activation was not requested.');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    activation = await prepareActivation({ integrationVersion: pack.version });
  }
  // Export only the initializer: OpenCode invokes every exported function as a plugin.
  const content = marker + `import { tool } from "@opencode-ai/plugin";\nimport TinyChat from ${JSON.stringify(plugin.href)};\nexport default input => TinyChat(input, { schema: tool.schema });\n`;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  if (activation) await writeActivation(activation);
  console.log(JSON.stringify({ ok: true, version: pack.version, opencodeVersion: '1.18.31', pluginPath: path, pluginSha256: createHash('sha256').update(bytes).digest('hex'), restartRequired: !values.activate,
    ...(values.activate ? { activation: activation ? 'reloading' : 'already-loaded' } : {}) }));
  if (activation) {
    process.kill(activation.hostPID, 'SIGUSR2');
    // Native disposal cancels this tool. Keep it running until that happens so
    // the old model loop cannot race the new plugin's continuation.
    await new Promise(resolve => setTimeout(resolve, 15000));
    throw new Error('OpenCode did not complete activation; preserve the activation receipt for diagnosis.');
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: { code: error.code?.startsWith('OPENCODE_ACTIVATION_') ? error.code : 'OPENCODE_INSTALL_FAILED', message: error.message } }));
  process.exitCode = 1;
}
