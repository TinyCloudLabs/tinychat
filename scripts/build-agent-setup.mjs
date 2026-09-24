#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildSetupPrompt, createSetupContext } from '../frontend/src/lib/agent-setup-prompt.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  output: { type: 'string' },
  host: { type: 'string' },
  'setup-base-url': { type: 'string' },
} });
const output = resolve(values.output ?? join(root, 'frontend/public/agents'));
const config = JSON.parse(await readFile(join(root, 'frontend/src/lib/agent-setup.json'), 'utf8'));
const setupUrl = new URL(values['setup-base-url'] ?? config.setupUrl);
if (!['http:', 'https:'].includes(setupUrl.protocol) || setupUrl.username || setupUrl.password || setupUrl.search || setupUrl.hash) {
  throw new Error('TinyChat setup configuration has an invalid setup base URL.');
}
if (!setupUrl.pathname.endsWith('/')) setupUrl.pathname += '/';
const instructionsUrl = new URL('setup.md', setupUrl).href;
const context = createSetupContext([values.host ?? process.env.VITE_TINYCLOUD_HOST ?? config.dataHost]);
const prompt = buildSetupPrompt({ instructionsUrl }, context);
const contextJson = JSON.stringify(context, null, 2);
const replacements = {
  CLI_VERSION: config.cliVersion, PACK_VERSION: config.packVersion,
  INSTALLER_VERSION: config.installerVersion, PROMPT: prompt,
  SETUP_URL: setupUrl.href, SETUP_BASE_URL: setupUrl.href,
  INSTRUCTIONS_URL: instructionsUrl, DATA_HOST: context.host, SETUP_CONTEXT: contextJson,
};
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'setup.md']) {
  const template = await readFile(join(root, 'agent-setup', file), 'utf8');
  const content = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in replacements)) throw new Error(`Unknown setup placeholder: ${key}`);
    return file.endsWith('.html') ? escapeHtml(replacements[key]) : replacements[key];
  });
  await writeFile(join(output, file), content);
}
await writeFile(join(output, 'prompt.txt'), prompt + '\n');
await writeFile(join(output, 'context.json'), contextJson + '\n');
console.log(`Built public agent setup (${config.packVersion})`);
