#!/usr/bin/env node
import { createRetrieval, PACK_VERSION } from '../lib/retrieval.mjs';

const HELP = `TinyChat retrieval ${PACK_VERSION} (Node >=20, TinyCloud CLI >=0.9.0)

node scripts/retrieve.mjs COMMAND --profile NAME --host URL --space NAME_OR_URI --owner OWNER_DID [OPTIONS]

Commands:
  diagnostics   Check versions, expected owner, actual SQL read and one body read.
  find          Discover meeting metadata. --term searches metadata, not body content.
  read          Read the exact record selected by --ref, or continue with --cursor.
  search        Search literal transcript passages within a bounded catalog scope.

Required context: --profile, --host, --space, --owner (did:pkh:eip155:CHAIN:ADDRESS).
Optional executable: --tc PATH (otherwise resolves tc on PATH; never uses a shell).
find/search filters: --source, --from ISO_TIMESTAMP, --to ISO_TIMESTAMP, --limit 1..50.
search: --term TEXT required; --scan-limit 1..20 (default5 bodies per invocation).
read: --ref OPAQUE_REFERENCE or --cursor OPAQUE_CONTINUATION.
find/search continuation: --cursor OPAQUE_CONTINUATION with context only; do not repeat filters.
--version reports pack/runtime compatibility; --help prints this help.

Results are JSON envelope v1, <=24000 UTF8 bytes, with explicit continuation.
SQL catalog only: excludes user-KV-only and backend-only catalogs.
Body limit8MiB; every body page rereads and verifies the body digest and current access.
`;
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--help') process.stdout.write(HELP);
else if (argv.length === 1 && argv[0] === '--version') process.stdout.write(JSON.stringify({ packVersion: PACK_VERSION, envelopeVersion: 1, nodeMinimum: '20.0.0', cliMinimum: '0.9.0', setupCliMinimum: '0.10.0' }) + '\n');
else {
  const contextFlags = new Set(['profile', 'host', 'space', 'owner', 'tc']);
  const inputFlags = new Set(['term', 'source', 'from', 'to', 'limit', 'scan-limit', 'ref', 'cursor']);
  const context = {}, input = {};
  let invalid = Number(process.versions.node.split('.')[0]) < 20;
  const command = argv[0];
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]?.slice(2), value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !value || (!contextFlags.has(flag) && !inputFlags.has(flag))) { invalid = true; break; }
    const target = contextFlags.has(flag) ? context : input, key = flag === 'scan-limit' ? 'scanLimit' : flag;
    if (Object.hasOwn(target, key)) { invalid = true; break; }
    target[key] = ['limit', 'scanLimit'].includes(key) ? (/^[0-9]+$/.test(value) ? Number(value) : NaN) : value;
  }
  const abort = new AbortController();
  const onStop = () => abort.abort();
  process.once('SIGINT', onStop); process.once('SIGTERM', onStop);
  const result = await createRetrieval({ ...(invalid ? {} : context), signal: abort.signal }).invoke(invalid ? null : command, input);
  process.removeListener('SIGINT', onStop); process.removeListener('SIGTERM', onStop);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 1;
}
