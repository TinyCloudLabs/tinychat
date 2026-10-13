#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { planVoiceNoteBackfill } from './voice-note-backfill-plan.mjs';

const TC = `${execFileSync('npm', ['prefix', '--global'], { encoding: 'utf8' }).trim()}/bin/tc`;

const SPACE = 'applications';
const DB = 'xyz.tinycloud.tinychat/connectors';
const PREFIX = `${DB}/exo-voice-note`;
const MAX_SECONDS_DEFAULT = 7200;

function parseArgs(args) {
  let profile = 'meeting-digest';
  let maxSeconds = MAX_SECONDS_DEFAULT;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (/^--(apply|write|transcribe|delete|commit|repair|execute|backfill)(?:=|$)/i.test(arg)) {
      throw new Error(`refusing write-capable option: ${arg.split('=')[0]}`);
    }
    if (arg === '--profile' || arg === '--max-seconds') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--profile') {
        if (!/^[\w.-]+$/.test(value)) throw new Error('invalid profile name');
        profile = value;
      } else {
        maxSeconds = Number(value);
        if (!Number.isFinite(maxSeconds) || maxSeconds < 0) throw new Error('--max-seconds must be a non-negative number');
      }
      continue;
    }
    throw new Error(`unsupported option: ${arg}`);
  }
  return { profile, maxSeconds };
}

function tc(profile, args, { raw = false } = {}) {
  try {
    return execFileSync(TC, ['--quiet', '--profile', profile, ...args], {
      encoding: raw ? 'buffer' : 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // CLI diagnostics can contain values from the requested key. Never forward them.
    throw new Error('tc read failed; verify the selected profile has read access');
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

function resultRows(result) {
  if (!Array.isArray(result?.columns) || !Array.isArray(result?.rows)) throw new Error('unexpected SQL result shape');
  const indexes = Object.fromEntries(result.columns.map((column, index) => [column, index]));
  return result.rows.map(values => Object.fromEntries(Object.entries(indexes).map(([column, index]) => [column, values[index]])));
}

function keySet(result) {
  if (!Array.isArray(result?.keys) || result.keys.some(key => typeof key !== 'string')) throw new Error('unexpected KV list result shape');
  return new Set(result.keys);
}

function parseBodyState(bytes) {
  const body = bytes.toString('utf8');
  if (body.length === 0) return { bodyHasText: false, bodyBytes: 0 };
  try {
    const value = JSON.parse(body);
    if (Array.isArray(value)) {
      const hasText = value.some(sentence => typeof sentence?.text === 'string' && sentence.text.trim().length > 0);
      return { bodyHasText: hasText, bodyBytes: bytes.length };
    }
    if (value && typeof value === 'object') {
      return { bodyHasText: typeof value.text === 'string' && value.text.trim().length > 0, bodyBytes: bytes.length };
    }
    return { bodyHasText: typeof value === 'string' && value.trim().length > 0, bodyBytes: bytes.length };
  } catch {
    return { bodyHasText: body.toString().trim().length > 0, bodyBytes: bytes.length };
  }
}

function readKey(profile, key) {
  // Raw values stay inside this process; body text is never logged or included in errors.
  return tc(profile, ['kv', 'get', '--raw', key, '--space', SPACE], { raw: true });
}

function audioForRow(profile, sourceId, allAudioKeys) {
  const base = `${PREFIX}/audio/${sourceId}`;
  const manifestKey = `${base}/manifest`;
  const legacyKeyPresent = allAudioKeys.has(base);
  const partKeys = new Set([...allAudioKeys].filter(key => key.startsWith(`${base}/p/`)));
  if (!allAudioKeys.has(manifestKey)) {
    return legacyKeyPresent
      ? { present: true, partCount: 1, manifestPartsComplete: true }
      : { present: false, partCount: partKeys.size, manifestPartsComplete: false };
  }

  let manifest;
  try {
    manifest = JSON.parse(readKey(profile, manifestKey).toString('utf8'));
  } catch {
    throw new Error(`invalid audio manifest for source_id ${sourceId}`);
  }
  if (!manifest || manifest.v !== 1 || !Array.isArray(manifest.parts)) {
    throw new Error(`invalid audio manifest for source_id ${sourceId}`);
  }
  let presentParts = 0;
  for (let index = 0; index < manifest.parts.length; index++) {
    const partKey = `${base}/p/${String(index).padStart(6, '0')}`;
    if (partKeys.has(partKey)) presentParts++;
  }
  const manifestPartsComplete = presentParts === manifest.parts.length;
  return { present: manifestPartsComplete, partCount: presentParts, manifestPartsComplete };
}

function run(profile, maxSeconds) {
  const rowResult = jsonTc(profile, ['sql', 'query',
    `SELECT source_id, duration_secs, json_extract(metadata, '$.transcription_outcome') AS outcome, `
      + `json_extract(metadata, '$.transcription_error_code') AS error_code, `
      + `json_extract(metadata, '$.capture.platform') AS capture_platform, `
      + `json_extract(metadata, '$.capture.options.transcriber') AS capture_transcriber, `
      + `json_extract(metadata, '$.capture.source') AS capture_source, `
      + `json_extract(metadata, '$.platform') AS legacy_platform, `
      + `json_extract(metadata, '$.transcriber') AS legacy_transcriber `
      + `FROM connector_meeting WHERE source = 'exo-voice-note' ORDER BY started_at`,
    '--space', SPACE, '--db', DB]);
  const rows = resultRows(rowResult);
  const commitResult = jsonTc(profile, ['sql', 'query',
    'SELECT source_id FROM voice_note_transcript', '--space', SPACE, '--db', DB]);
  const committed = new Set(resultRows(commitResult).map(row => String(row.source_id)));
  const audioKeys = keySet(jsonTc(profile, ['kv', 'list', '--prefix', `${PREFIX}/audio/`, '--space', SPACE]));
  const bodyKeys = keySet(jsonTc(profile, ['kv', 'list', '--prefix', `${PREFIX}/transcript/`, '--space', SPACE]));

  const audioIndex = new Map();
  const planningRows = rows.map(row => {
    const sourceId = String(row.source_id);
    const audio = audioForRow(profile, sourceId, audioKeys);
    audioIndex.set(sourceId, audio);
    const bodyKey = `${PREFIX}/transcript/${sourceId}`;
    const body = bodyKeys.has(bodyKey) ? parseBodyState(readKey(profile, bodyKey)) : { bodyHasText: false, bodyBytes: 0 };
    return {
      source_id: sourceId,
      duration_secs: typeof row.duration_secs === 'number' ? row.duration_secs : null,
      metadata: {
        transcription_outcome: row.outcome,
        transcription_error_code: row.error_code,
      },
      hasTranscriptCommit: committed.has(sourceId),
      bodyHasText: body.bodyHasText,
      bodyBytes: body.bodyBytes,
      platform: row.capture_platform ?? row.capture_source ?? row.legacy_platform ?? null,
      transcriberOption: row.capture_transcriber ?? row.legacy_transcriber ?? null,
    };
  });

  const planned = planVoiceNoteBackfill(planningRows, audioIndex, { maxSeconds });
  const counts = Object.fromEntries(['eligible', 'skip-terminal', 'skip-has-body', 'skip-has-commit', 'skip-no-audio', 'skip-over-cap']
    .map(classification => [classification, planned.filter(item => item.classification === classification).length]));
  const eligible = planned.filter(item => item.classification === 'eligible').map(item => {
    const row = planningRows.find(candidate => candidate.source_id === item.source_id);
    const audio = audioIndex.get(item.source_id);
    return {
      source_id: item.source_id,
      duration_secs: row.duration_secs,
      platform: row.platform,
      transcriber_option: row.transcriberOption,
      audio_present: audio.present,
      part_count: audio.partCount,
      manifest_parts_complete: audio.manifestPartsComplete,
      plain_body_bytes: row.bodyBytes,
    };
  });
  const report = {
    total_rows: planningRows.length,
    max_seconds: maxSeconds,
    counts,
    failed_with_code_eligible: planned.filter(item => item.classification === 'eligible' && item.failedWithCode).length,
    eligible,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\napply: open Exo Library, Transcribe each listed note\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Read-only voice-note backfill dry run. Options: --profile NAME, --max-seconds N. Writes are not supported.\n');
  } else {
    run(options.profile, options.maxSeconds);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'dry run failed'}\n`);
  process.exitCode = 1;
}
