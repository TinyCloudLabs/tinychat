const TERMINAL_OUTCOMES = new Set(['transcribed', 'no_speech', 'skipped']);
const LEGACY_WINNER_OUTCOMES = new Set(['transcribed', 'no_speech']);
const NON_RETRYABLE_CODES = new Set([
  'recording_too_large', 'recording_too_long', 'recording_too_long_for_phone', 'unsupported_recording',
  'invalid_audio', 'no_speech', 'decode_failed', 'decode_unavailable', 'feature_unavailable',
  'service_misconfigured', 'audio_size_mismatch', 'VOICE_NOTE_AUDIO_CORRUPT', 'invalid_argument',
  'voice_note_not_found', 'transcription_off',
]);
const PTX_RAW_MIME_TYPES = new Set([
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm', 'audio/flac',
]);
const WAV_BYTES_PER_SECOND = 32_000;
const WAV_HEADER_BYTES = 44;

/**
 * Classify a fixed snapshot using the same authority order as Exo's readers.
 * This function has no storage or network dependencies.
 */
export function planVoiceNoteBackfill(rows, audioIndex, { maxSeconds = 7200, maxBytes = 120_960_000 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (!Number.isFinite(maxSeconds) || maxSeconds < 0) throw new RangeError('maxSeconds must be non-negative');
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be non-negative');

  return rows.map(row => {
    const sourceId = String(row.source_id ?? row.sourceId ?? '');
    const metadata = objectValue(row.metadata);
    const capture = objectValue(metadata.capture);
    const outcome = row.outcome ?? metadata.transcription_outcome ?? null;
    const errorCode = row.errorCode ?? metadata.transcription_error_code ?? null;
    const failedWithCode = outcome === 'failed' && typeof errorCode === 'string' && errorCode.length > 0;
    const duration = typeof row.duration_secs === 'number' && Number.isFinite(row.duration_secs)
      ? row.duration_secs
      : typeof capture.duration_ms === 'number' && Number.isFinite(capture.duration_ms)
        ? capture.duration_ms / 1000 : null;
    const captureVersion = row.captureVersion ?? capture.version ?? null;
    const transcriberOption = row.transcriberOption ?? objectValue(capture.options).transcriber ?? metadata.transcriber ?? null;
    const legacyWinner = row.legacyWinner?.metadata ?? row.legacyWinner;
    let classification;
    let reason;

    if (row.hasTranscriptCommit === true) {
      classification = 'has-commit';
      reason = 'authoritative voice_note_transcript commit exists';
    } else if (hasLegacyEvidence(legacyWinner) || hasLegacyEvidence(metadata)) {
      classification = 'skip-terminal';
      reason = 'legacy transcript winner contains terminal outcome or transcript text';
    } else if (row.bodyHasText === true) {
      classification = 'legacy-body-no-commit';
      reason = 'DO NOT TAP: Transcribe would overwrite a legacy body';
    } else if (TERMINAL_OUTCOMES.has(outcome)) {
      classification = 'skip-terminal';
      reason = `terminal outcome: ${outcome}`;
    } else if (transcriberOption === 'off') {
      classification = 'skip-opted-out';
      reason = 'capture transcriber was explicitly off';
    } else if (captureVersion === 2 && transcriberOption !== 'private-cloud') {
      classification = 'needs-original-phone';
      reason = 'v2 capture is not privately transcribable from the web Library';
    } else if (failedWithCode && NON_RETRYABLE_CODES.has(errorCode)) {
      classification = 'skip-non-retryable';
      reason = `non-retryable failure code: ${errorCode}`;
    } else {
      const audio = lookupAudio(audioIndex, sourceId);
      if (audio?.classification === 'audio-corrupt' || audio?.classification === 'audio-too-large-to-check') {
        classification = audio.classification;
        reason = audio.reason ?? (classification === 'audio-corrupt'
          ? 'audio manifest is malformed' : 'legacy audio exceeds the safe inspection buffer');
      } else if (!audio || audio.present !== true) {
        classification = 'skip-no-audio';
        reason = 'audio manifest or audio parts are absent';
      } else if (duration !== null && duration > maxSeconds) {
        classification = 'skip-over-cap';
        reason = `duration ${duration}s exceeds maxSeconds ${maxSeconds}s`;
      } else if (estimatedPtxBytes(audio, duration) > maxBytes) {
        classification = 'over-ptx-bytes';
        reason = `estimated PTX upload size ${estimatedPtxBytes(audio, duration)} exceeds maxBytes ${maxBytes}`;
      } else {
        classification = 'eligible';
        reason = failedWithCode ? `retry failed outcome (${errorCode})` : 'no transcript evidence or terminal outcome';
      }
    }

    const audio = lookupAudio(audioIndex, sourceId);
    return {
      source_id: sourceId, classification, reason, failedWithCode, errorCode: errorCode ?? null,
      duration_secs: duration, captureVersion, transcriberOption,
      estimatedPtxBytes: audio?.present ? estimatedPtxBytes(audio, duration) : null,
    };
  });
}

function estimatedPtxBytes(audio, duration) {
  const mimeType = typeof audio.mimeType === 'string' ? audio.mimeType : null;
  if (mimeType === null) return null;
  // Match prepareTranscriptionAudio's current exact MIME comparison. Parameter stripping there is a follow-up.
  if (PTX_RAW_MIME_TYPES.has(mimeType)) return typeof audio.size === 'number' ? audio.size : null;
  return duration === null ? null : WAV_HEADER_BYTES + WAV_BYTES_PER_SECOND * duration;
}

export function hasLegacyEvidence(value) {
  const metadata = objectValue(value);
  return LEGACY_WINNER_OUTCOMES.has(metadata.transcription_outcome)
    || (metadata.transcription_outcome == null
      && typeof metadata.transcript_text === 'string' && metadata.transcript_text.trim().length > 0);
}

/** The same legacy predicate and winner order as readLegacyTranscriptWinner. */
export function legacyTranscriptWinner(rows) {
  return rows.filter(row => {
    if (row.source !== 'exo-voice-note' && row.source !== 'exo-voice-note-dup') return false;
    return hasLegacyEvidence(row.metadata);
  }).sort((a, b) => {
    const at = String(objectValue(a.metadata).transcribed_at ?? '');
    const bt = String(objectValue(b.metadata).transcribed_at ?? '');
    return (at === bt ? 0 : at > bt ? -1 : 1)
      || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  })[0] ?? null;
}

/** Select the post-identity canonical row: the lowest-id live row per source_id. */
export function dedupeCanonicalRows(rows) {
  const canonical = new Map();
  for (const row of rows) {
    if (row.source !== 'exo-voice-note') continue;
    const sourceId = String(row.source_id ?? '');
    const current = canonical.get(sourceId);
    if (!current || String(row.id) < String(current.id)) canonical.set(sourceId, row);
  }
  return [...canonical.values()].sort((a, b) => {
    const left = String(a.source_id);
    const right = String(b.source_id);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Mirrors audioStore.parseAudioManifest's schema, part-size, and total-size checks. */
export function parseAudioManifest(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const manifest = value;
  if (manifest.v !== 1
    || typeof manifest.mimeType !== 'string'
    || typeof manifest.fileName !== 'string'
    || !isNonNegativeInteger(manifest.size)
    || !isNonNegativeInteger(manifest.partSize)
    || (manifest.sha256 !== null && typeof manifest.sha256 !== 'string')
    || typeof manifest.createdAt !== 'string'
    || !Array.isArray(manifest.parts)) return null;

  let size = 0;
  const parts = [];
  for (const part of manifest.parts) {
    if (!part || typeof part !== 'object'
      || !isNonNegativeInteger(part.size)
      || (part.etag !== null && typeof part.etag !== 'string')) return null;
    parts.push({ size: part.size, etag: part.etag });
    size += part.size;
  }
  if (size !== manifest.size) return null;
  return {
    v: 1, mimeType: manifest.mimeType, fileName: manifest.fileName, size: manifest.size,
    partSize: manifest.partSize, parts, sha256: manifest.sha256, createdAt: manifest.createdAt,
  };
}

function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function objectValue(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function lookupAudio(index, sourceId) {
  if (index instanceof Map) return index.get(sourceId);
  if (index && typeof index === 'object') return index[sourceId];
  return undefined;
}
