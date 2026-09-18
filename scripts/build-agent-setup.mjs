#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { output: { type: 'string' } } });
const output = resolve(values.output ?? join(root, 'frontend/public/agents'));
const config = JSON.parse(await readFile(join(root, 'frontend/src/lib/agent-setup.json'), 'utf8'));
const replacements = { CLI_VERSION: config.cliVersion, PACK_VERSION: config.packVersion, INSTALLER_VERSION: config.installerVersion, PROMPT: config.prompt };
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
await writeFile(join(output, 'prompt.txt'), config.prompt + '\n');
console.log(`Built public agent setup (${config.packVersion})`);
