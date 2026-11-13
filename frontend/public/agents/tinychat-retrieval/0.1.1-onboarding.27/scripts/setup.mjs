#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createSetup } from '../lib/setup.mjs';

const HELP = `TinyChat setup. It uses your TinyCloud onboarding profile (TC_PROFILE, else default).

  prepare [--config APP_JSON]   Check the profile. Reports ready, onboarding-required or access-required.
  authorize                     For access-required: prints approvalUrl and a one-line message to send the owner.
  login --code CODE             Pass the code the owner sent, exactly as sent. Without --code, reads it from stdin.
  context                       Print the saved context.

onboarding-required: set up TinyCloud with https://agents.tinycloud.xyz/onboarding, then run prepare again.`;

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 1024 * 1024) break; }
  return text;
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' }, code: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log(HELP);
  } else {
    const command = positionals[0];
    if (!['prepare', 'context', 'authorize', 'login'].includes(command) || positionals.length !== 1 || (command !== 'prepare' && values.config) || (command !== 'login' && values.code !== undefined)) throw new Error('Use --help for supported setup commands.');
    if (!process.env.HOME) throw new Error('Terminal HOME is required to save the TinyChat setup.');
    const statePath = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'tinychat-retrieval/setup.json');
    const setup = createSetup({ statePath });
    let result;
    if (command === 'login') {
      if (values.code === undefined && process.stdin.isTTY) throw new Error('Use login --code CODE with the code the owner sent.');
      result = await setup.login(values.code ?? await readStdin());
    } else if (command === 'authorize') result = await setup.authorize();
    else if (command === 'context') result = await setup.context();
    else result = await setup.prepare({ config: values.config ? JSON.parse(await readFile(values.config, 'utf8')) : undefined });
    console.log(JSON.stringify({ ok: true, ...result }));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: { code: error.code ?? 'SETUP_ERROR', message: error.code ? error.message : 'Setup failed. Check the app configuration file and --help.' } }));
  process.exitCode = 1;
}
