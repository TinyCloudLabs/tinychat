const fail = code => { throw Object.assign(new Error(code === 'SPEAKER_MISMATCH' ? 'Named speaker does not match every cited span.' : 'Evidence has invalid source or original offsets.'), { code }); };

/** Formatting preserves evidence; it cannot decide whether a claim follows from it. */
export function formatSpanEvidence(record, span, provenance) {
  if (typeof record?.source !== 'string' || typeof record?.id !== 'string' || !record.source || !record.id ||
      !Number.isSafeInteger(span?.recordIndex) || span.recordIndex < 0 || !Number.isSafeInteger(span.start) || span.start < 0 ||
      !Number.isSafeInteger(span.end) || typeof span.text !== 'string' || span.end - span.start !== span.text.length) fail('INVALID_EVIDENCE');
  const contentKind = provenance?.contentKind;
  const citation = `[${record.source}/id=${record.id}; recordIndex=${span.recordIndex}; UTF-16 ${span.start}–${span.end}, end exclusive${contentKind === 'generated-notes' ? '; generated-notes' : ''}]`;
  return { ...span, source: record.source, id: record.id, ...(contentKind ? { contentKind } : {}), citation };
}

/** Named attribution is exact. Wording, consensus and commitment still need review. */
export function citeSpans(evidence, { speaker } = {}) {
  if (!Array.isArray(evidence) || !evidence.length) fail('INVALID_EVIDENCE');
  return evidence.map(span => {
    if (speaker !== undefined && (!speaker || span.speaker !== speaker)) fail('SPEAKER_MISMATCH');
    return formatSpanEvidence({ source: span.source, id: span.id }, span, span).citation;
  }).join(' ');
}
