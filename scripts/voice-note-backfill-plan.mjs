const TERMINAL_OUTCOMES = new Set(['transcribed', 'no_speech', 'skipped']);

/**
 * Classify a fixed snapshot of voice-note rows and audio availability. The
 * planner has no storage or network dependencies; callers own the snapshot.
 */
export function planVoiceNoteBackfill(rows, audioIndex, { maxSeconds = 7200 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (!Number.isFinite(maxSeconds) || maxSeconds < 0) throw new RangeError('maxSeconds must be non-negative');

  return rows.map(row => {
    const sourceId = String(row.source_id ?? row.sourceId ?? '');
    const metadata = objectValue(row.metadata);
    const outcome = row.outcome ?? metadata.transcription_outcome ?? null;
    const errorCode = row.errorCode ?? metadata.transcription_error_code ?? null;
    const failedWithCode = outcome === 'failed' && typeof errorCode === 'string' && errorCode.length > 0;
    let classification;
    let reason;

    if (TERMINAL_OUTCOMES.has(outcome)) {
      classification = 'skip-terminal';
      reason = `terminal outcome: ${outcome}`;
    } else if (row.bodyHasText === true) {
      classification = 'skip-has-body';
      reason = 'plain transcript body contains text';
    } else if (row.hasTranscriptCommit === true) {
      classification = 'skip-has-commit';
      reason = 'voice_note_transcript commit already exists';
    } else {
      const optedOut = row.transcriberOption === 'off'
        || metadata.capture?.options?.transcriber === 'off'
        || metadata.transcriber === 'off';
      if (optedOut) {
        classification = 'skip-opted-out';
        reason = 'capture transcriber was explicitly off';
      } else {
        const audio = lookupAudio(audioIndex, sourceId);
        if (!audio || audio.present !== true) {
          classification = 'skip-no-audio';
          reason = 'audio manifest or audio parts are absent';
        } else if (Number.isFinite(row.duration_secs) && row.duration_secs > maxSeconds) {
          classification = 'skip-over-cap';
          reason = `duration ${row.duration_secs}s exceeds maxSeconds ${maxSeconds}s`;
        } else {
          classification = 'eligible';
          reason = failedWithCode ? `retry failed outcome (${errorCode})` : 'no terminal outcome or transcript body';
        }
      }
    }

    return { source_id: sourceId, classification, reason, failedWithCode };
  });
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function lookupAudio(index, sourceId) {
  if (index instanceof Map) return index.get(sourceId);
  if (index && typeof index === 'object') return index[sourceId];
  return undefined;
}
