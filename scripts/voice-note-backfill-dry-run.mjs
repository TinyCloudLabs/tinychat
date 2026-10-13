#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  collectVoiceNoteBackfillReport,
  DB,
  SPACE,
} from './voice-note-backfill-report.mjs';

const MAX_SECONDS_DEFAULT = 7200;
const MAX_BYTES_DEFAULT = 120_960_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export function parseArgs(args) {
  let profile = 'meeting-digest';
  let maxSeconds = MAX_SECONDS_DEFAULT;
  let maxBytes = MAX_BYTES_DEFAULT;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (/^--(apply|write|transcribe|delete|commit|repair|execute|backfill)(?:=|$)/i.test(arg)) {
      throw new Error(`refusing write-capable option: ${arg.split('=')[0]}`);
    }
    if (arg === '--profile' || arg === '--max-seconds' || arg === '--max-bytes') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--profile') {
        if (!/^[\w.-]+$/.test(value)) throw new Error('invalid profile name');
        profile = value;
      } else if (arg === '--max-seconds') {
        maxSeconds = Number(value);
        if (!Number.isFinite(maxSeconds) || maxSeconds < 0) throw new Error('--max-seconds must be non-negative');
      } else {
        maxBytes = Number(value);
        if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('--max-bytes must be non-negative');
      }
      continue;
    }
    throw new Error(`unsupported option: ${arg}`);
  }
  return { profile, maxSeconds, maxBytes };
}

let cachedTcBinary;

function tcBinary() {
  return cachedTcBinary ??= `${execFileSync('npm', ['prefix', '--global'], { encoding: 'utf8' }).trim()}/bin/tc`;
}

function tc(profile, args, { raw = false } = {}) {
  try {
    return execFileSync(tcBinary(), ['--quiet', '--profile', profile, ...args], {
      encoding: raw ? 'buffer' : 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = new Error('tc read failed; verify the selected profile has read access');
    failure.code = error?.code;
    throw failure;
  }
}

function jsonTc(profile, args) {
  const output = tc(profile, ['--json', ...args]);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('tc returned invalid JSON');
  }
}

function readOnlyAdapter(profile) {
  return {
    sqlQuery: sql => jsonTc(profile, ['sql', 'query', sql, '--space', SPACE, '--db', DB]),
    kvList: prefix => {
      const result = jsonTc(profile, ['kv', 'list', '--prefix', prefix, '--space', SPACE]);
      if (!Array.isArray(result?.keys) || result.keys.some(key => typeof key !== 'string')) {
        throw new Error('unexpected KV list result shape');
      }
      return result.keys;
    },
    kvGet: key => tc(profile, ['kv', 'get', '--raw', key, '--space', SPACE], { raw: true }),
  };
}

function run(profile, maxSeconds, maxBytes) {
  const report = collectVoiceNoteBackfillReport({
    ...readOnlyAdapter(profile),
    maxSeconds,
    maxBytes,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\napply: open Exo Library, Transcribe eligible notes one at a time; DO NOT TAP listed legacy bodies\n`);
}

function isDirectExecution() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Read-only voice-note backfill dry run. Options: --profile NAME, --max-seconds N, --max-bytes N. Writes are not supported.\n');
    } else {
      run(options.profile, options.maxSeconds, options.maxBytes);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'dry run failed'}\n`);
    process.exitCode = 1;
  }
}
