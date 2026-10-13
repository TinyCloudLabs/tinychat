import {
  dedupeCanonicalRows,
  legacyTranscriptWinner,
  parseAudioManifest,
  planVoiceNoteBackfill,
} from './voice-note-backfill-plan.mjs';

export const SPACE = 'applications';
export const DB = 'xyz.tinycloud.tinychat/connectors';
export const VOICE_NOTE_PREFIX = `${DB}/exo-voice-note`;
export const AUDIO_PREFIX = `${VOICE_NOTE_PREFIX}/audio`;
export const TRANSCRIPT_PREFIX = `${VOICE_NOTE_PREFIX}/transcript`;

const CLASSIFICATIONS = [
  'eligible', 'skip-terminal', 'has-commit', 'legacy-body-no-commit', 'skip-opted-out',
  'needs-original-phone', 'skip-non-retryable', 'skip-no-audio', 'skip-over-cap',
  'over-ptx-bytes', 'audio-corrupt', 'audio-too-large-to-check',
];
const LEGACY_COMMIT_TABLE_SQL = "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'voice_note_transcript'";
const MEETING_ROWS_SQL = `SELECT id, source, source_id, duration_secs, metadata FROM connector_meeting
  WHERE source IN ('exo-voice-note', 'exo-voice-note-dup') ORDER BY source_id, id`;
const COMMITS_SQL = 'SELECT source_id FROM voice_note_transcript';

/**
 * Build an operator report from read-only SQL/KV adapters. The adapter exposes
 * only query/list/get operations so tests cannot accidentally write data.
 */
export function collectVoiceNoteBackfillReport({
  sqlQuery,
  kvList,
  kvGet,
  maxSeconds = 7200,
  maxBytes = 120_960_000,
}) {
  const meetings = resultRows(sqlQuery(MEETING_ROWS_SQL)).map(row => ({
    id: String(row.id), source: String(row.source), source_id: String(row.source_id),
    duration_secs: typeof row.duration_secs === 'number' ? row.duration_secs : null,
    metadata: row.metadata,
  }));

  const commitTable = resultRows(sqlQuery(LEGACY_COMMIT_TABLE_SQL)).length > 0;
  const commits = commitTable
    ? new Set(resultRows(sqlQuery(COMMITS_SQL)).map(row => String(row.source_id)))
    : new Set();

  const audioKeys = new Set(kvList(`${AUDIO_PREFIX}/`));
  const bodyKeys = new Set(kvList(`${TRANSCRIPT_PREFIX}/`));
  const audioIndex = new Map();
  const bodyIndex = new Map();
  const canonicalRows = dedupeCanonicalRows(meetings);

  for (const row of canonicalRows) {
    const sourceId = row.source_id;
    audioIndex.set(sourceId, audioForRow(sourceId, audioKeys, kvGet));
    const bodyKey = `${TRANSCRIPT_PREFIX}/${sourceId}`;
    bodyIndex.set(sourceId, bodyKeys.has(bodyKey)
      ? parseBodyState(asBuffer(kvGet(bodyKey)))
      : { bodyHasText: false, bodyBytes: 0 });
  }

  const planningRows = canonicalRows.map(row => {
    const metadata = parseMetadata(row.metadata);
    const group = meetings.filter(candidate => candidate.source_id === row.source_id);
    const winner = legacyTranscriptWinner(group);
    const capture = objectValue(metadata.capture);
    return {
      ...row,
      metadata,
      legacyWinner: winner ? { metadata: winner.metadata } : null,
      hasTranscriptCommit: commits.has(row.source_id),
      ...bodyIndex.get(row.source_id),
      platform: capture.platform ?? metadata.platform ?? null,
      captureVersion: capture.version ?? null,
      transcriberOption: objectValue(capture.options).transcriber ?? metadata.transcriber ?? null,
    };
  });

  const planned = planVoiceNoteBackfill(planningRows, audioIndex, { maxSeconds, maxBytes });
  const details = planned.map(item => {
    const audio = audioIndex.get(item.source_id) ?? {};
    const body = bodyIndex.get(item.source_id) ?? {};
    const row = planningRows.find(candidate => candidate.source_id === item.source_id);
    return {
      source_id: item.source_id,
      classification: item.classification,
      reason: item.reason,
      error_code: item.errorCode,
      duration_secs: item.duration_secs,
      platform: row?.platform ?? null,
      capture_version: item.captureVersion,
      transcriber_option: item.transcriberOption,
      mime_type: audio.mimeType ?? null,
      manifest_size_bytes: audio.manifestSizeBytes ?? null,
      estimated_ptx_bytes: item.estimatedPtxBytes,
      audio_size_bytes: audio.size ?? null,
      audio_present: audio.present === true,
      part_count: audio.partCount ?? 0,
      manifest_part_count: audio.manifestPartCount ?? null,
      manifest_parts_complete: audio.manifestPartsComplete === true,
      audio_key_shape: audio.keyShape ?? null,
      legacy_key_present: audio.legacyKeyPresent === true,
      legacy_key_bytes: audio.legacyKeyBytes ?? null,
      legacy_audio_bytes: audio.legacyAudioBytes ?? null,
      plain_body_bytes: body.bodyBytes ?? 0,
    };
  });
  const byClass = classification => details.filter(item => item.classification === classification);
  const counts = Object.fromEntries(CLASSIFICATIONS.map(classification => [classification, byClass(classification).length]));
  const manifests = details.filter(item => item.manifest_size_bytes !== null).map(item => ({
    source_id: item.source_id,
    mime_type: item.mime_type,
    size_bytes: item.manifest_size_bytes,
  }));
  const doNotTap = byClass('legacy-body-no-commit').map(item => ({
    source_id: item.source_id,
    warning: 'DO NOT TAP: Transcribe would overwrite a legacy body',
  }));

  return {
    total_rows: planningRows.length,
    max_seconds: maxSeconds,
    max_bytes: maxBytes,
    counts,
    failed_with_code_eligible: byClass('eligible').filter(item => item.error_code !== null).length,
    eligible: byClass('eligible'),
    do_not_tap: doNotTap,
    non_retryable: byClass('skip-non-retryable'),
    needs_original_phone: byClass('needs-original-phone'),
    opted_out: byClass('skip-opted-out'),
    audio_manifests: manifests,
    notes: details,
  };
}

function audioForRow(sourceId, allKeys, kvGet) {
  const base = `${AUDIO_PREFIX}/${sourceId}`;
  const manifestKey = `${base}/manifest`;
  const legacyKeyPresent = allKeys.has(base);
  const partKeys = new Set([...allKeys].filter(key => key.startsWith(`${base}/p/`)));

  if (allKeys.has(manifestKey)) {
    const manifest = parseAudioManifest(asBuffer(kvGet(manifestKey)).toString('utf8'));
    if (!manifest) return corruptAudio('audio manifest is malformed');
    let presentParts = 0;
    for (let index = 0; index < manifest.parts.length; index++) {
      const partKey = `${base}/p/${String(index).padStart(6, '0')}`;
      if (partKeys.has(partKey)) presentParts++;
    }
    const complete = presentParts === manifest.parts.length;
    return {
      present: complete,
      classification: null,
      mimeType: manifest.mimeType,
      size: manifest.size,
      manifestSizeBytes: manifest.size,
      partCount: presentParts,
      manifestPartCount: manifest.parts.length,
      manifestPartsComplete: complete,
      keyShape: 'manifest-and-parts',
      legacyKeyPresent,
      legacyKeyBytes: null,
      legacyAudioBytes: null,
    };
  }

  if (legacyKeyPresent) {
    let raw;
    try { raw = asBuffer(kvGet(base)); }
    catch (error) {
      if (isBufferOverflow(error)) return {
        present: false, classification: 'audio-too-large-to-check', reason: 'legacy whole-audio value exceeded the inspection buffer',
        partCount: 0, manifestPartCount: null, manifestPartsComplete: false,
        keyShape: 'legacy-base-value-too-large-to-check', legacyKeyPresent: true,
        legacyKeyBytes: null, legacyAudioBytes: null, mimeType: null, size: null, manifestSizeBytes: null,
      };
      throw error;
    }
    let value;
    try {
      value = JSON.parse(raw.toString('utf8'));
      if (typeof value === 'string') value = JSON.parse(value);
    } catch {
      return corruptAudio('legacy whole-audio value is malformed', raw.byteLength);
    }
    if (!value || typeof value !== 'object' || typeof value.mimeType !== 'string' || typeof value.base64 !== 'string') {
      return corruptAudio('legacy whole-audio value has an invalid shape', raw.byteLength);
    }
    const size = Buffer.from(value.base64, 'base64').byteLength;
    return {
      present: true, classification: null, mimeType: value.mimeType, size, manifestSizeBytes: null,
      partCount: 1, manifestPartCount: 1, manifestPartsComplete: true,
      keyShape: 'legacy-base-value', legacyKeyPresent: true, legacyKeyBytes: raw.byteLength, legacyAudioBytes: size,
    };
  }

  return {
    present: false, classification: null, mimeType: null, size: null, manifestSizeBytes: null,
    partCount: partKeys.size, manifestPartCount: null, manifestPartsComplete: false,
    keyShape: 'none', legacyKeyPresent: false, legacyKeyBytes: null, legacyAudioBytes: null,
  };
}

function corruptAudio(reason, legacyKeyBytes = null) {
  return {
    present: false, classification: 'audio-corrupt', reason, mimeType: null, size: null,
    manifestSizeBytes: null, partCount: 0, manifestPartCount: null, manifestPartsComplete: false,
    keyShape: 'invalid', legacyKeyPresent: legacyKeyBytes !== null, legacyKeyBytes, legacyAudioBytes: null,
  };
}

function parseBodyState(bytes) {
  const body = bytes.toString('utf8');
  if (body.length === 0) return { bodyHasText: false, bodyBytes: 0 };
  try {
    const value = JSON.parse(body);
    if (Array.isArray(value)) {
      return { bodyHasText: value.some(sentence => typeof sentence?.text === 'string' && sentence.text.trim().length > 0), bodyBytes: bytes.length };
    }
    if (value && typeof value === 'object') {
      return { bodyHasText: typeof value.text === 'string' && value.text.trim().length > 0, bodyBytes: bytes.length };
    }
    return { bodyHasText: typeof value === 'string' && value.trim().length > 0, bodyBytes: bytes.length };
  } catch {
    return { bodyHasText: body.trim().length > 0, bodyBytes: bytes.length };
  }
}

function resultRows(result) {
  if (!Array.isArray(result?.columns) || !Array.isArray(result?.rows)) throw new Error('unexpected SQL result shape');
  const indexes = Object.fromEntries(result.columns.map((column, index) => [column, index]));
  return result.rows.map(values => Object.fromEntries(Object.entries(indexes).map(([column, index]) => [column, values[index]])));
}

function parseMetadata(value) {
  if (typeof value !== 'string') return objectValue(value);
  try { return objectValue(JSON.parse(value)); } catch { return {}; }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function isBufferOverflow(error) {
  return error?.code === 'ENOBUFS' || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}
