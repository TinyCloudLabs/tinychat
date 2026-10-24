// R1 guard (TC-1978): the sink checks code and integer values by SHAPE, not against a list of allowed values. So a call
// site that puts an identifier or a name into one of those keys would ship it if it happened to have the right shape.
// This scan lists every `key=${expression}` interpolation in backend/src for the shape-checked keys; the reviewed list is
// log-shipper/call-sites.json. A new (file, key, expression) fails the contract test until a reviewer has looked at it and
// regenerated the list (`node log-shipper/scan.mjs --write`). Literal values (`op=deliver`) are constants and not listed.
// Three shapes are recognised: `key=${expression}`, a string that ends in `key=` and is concatenated with `+ expression`, and a
// dynamic key, `${name}=${expression}` (listed as the key `${name}`).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyClasses } from './build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const listPath = resolve(root, 'log-shipper/call-sites.json');

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Sorted unique `file|key|expression` entries (expression whitespace collapsed). */
export function scanCallSites(base = resolve(root, 'backend/src')) {
  const classes = keyClasses();
  const keys = [...classes.code, ...classes.int, ...classes.bool];
  const renamed = { waited_ms: 'waitedMs', item_count: 'ids' };
  const names = keys.flatMap(key => renamed[key] ? [key, renamed[key]] : [key]);
  const interpolated = new RegExp(String.raw`(?<![A-Za-z0-9_])(${names.join('|')})=\$\{((?:[^{}]|\{[^{}]*\})*)\}`, 'g');
  const concatenated = new RegExp(String.raw`(?<![A-Za-z0-9_])(${names.join('|')})=["'\x60]\s*\+\s*([^,;)\n"'\x60]+)`, 'g');
  const dynamicKey = /\$\{([^{}]+)\}=\$\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  const tidy = text => text.replace(/\s+/g, ' ').trim();
  const found = new Set();
  for (const file of sources(base)) {
    const text = readFileSync(file, 'utf8');
    const name = relative(root, file);
    for (const match of text.matchAll(interpolated)) found.add(`${name}|${match[1]}|${tidy(match[2])}`);
    for (const match of text.matchAll(concatenated)) found.add(`${name}|${match[1]}|+ ${tidy(match[2]).replace(/\s*\+$/, '')}`);
    for (const match of text.matchAll(dynamicKey)) found.add(`${name}|\${${tidy(match[1])}}|${tidy(match[2])}`);
  }
  return [...found].sort();
}

export const reviewedCallSites = () => JSON.parse(readFileSync(listPath, 'utf8')).entries;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--write') {
  writeFileSync(listPath, JSON.stringify({ note: 'Reviewed key=${expression} call sites for shape-checked sink keys; regenerate with node log-shipper/scan.mjs --write after review.', entries: scanCallSites() }, null, 2) + '\n');
}
