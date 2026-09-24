import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../lib/evidence.mjs').catch(() => ({}));
const record = { source: 'fireflies', id: 'synthetic-meeting' };
const span = (speaker, recordIndex, text, start = 0) => ({ speaker, recordIndex, text, start, end: start + text.length, startSecs: recordIndex * 7 });

test('displayed evidence keeps distinct speakers and proposal/preference/agreement wording attached to exact citations', () => {
  assert.equal(typeof api.formatSpanEvidence, 'function');
  const fixtures = [span('Alex', 12, 'Could we import the previous material?'), span('Bea', 13, 'I prefer fewer clicks.'), span('Cai', 14, 'I agree to test the import tomorrow.')];
  const shown = fixtures.map(value => api.formatSpanEvidence(record, value, { contentKind: 'transcript' }));
  for (let i = 0; i < shown.length; i++) {
    assert.equal(shown[i].text, fixtures[i].text);
    assert.equal(shown[i].speaker, fixtures[i].speaker);
    assert.equal(shown[i].source, record.source);
    assert.equal(shown[i].id, record.id);
    assert.match(shown[i].citation, new RegExp(`recordIndex=${12 + i}; UTF-16 0–${fixtures[i].end}`));
    assert.match(shown[i].citation, /fireflies\/id=synthetic-meeting/);
    assert.equal(shown[i].startSecs, fixtures[i].startSecs);
  }
  assert.equal(api.citeSpans([shown[0]], { speaker: 'Alex' }), shown[0].citation);
  assert.throws(() => api.citeSpans([shown[0]], { speaker: 'Cai' }), { code: 'SPEAKER_MISMATCH' });
  assert.throws(() => api.citeSpans(shown, { speaker: 'Alex' }), { code: 'SPEAKER_MISMATCH' });
  assert.equal(api.citeSpans(shown), shown.map(value => value.citation).join(' '));
});

test('split spans preserve original UTF-16 offsets, unknown speakers and generated-notes provenance', () => {
  assert.equal(typeof api.formatSpanEvidence, 'function');
  const first = api.formatSpanEvidence(record, span('Bea', 42, '🙂 First ', 17), { contentKind: 'generated-notes' });
  const second = api.formatSpanEvidence(record, span('Bea', 42, 'second.', first.end), { contentKind: 'generated-notes' });
  assert.equal(second.start, first.end);
  assert.equal(second.recordIndex, first.recordIndex);
  assert.equal(first.contentKind, 'generated-notes');
  assert.match(first.citation, /generated-notes/);
  const unknown = api.formatSpanEvidence(record, { recordIndex: 1, text: 'Unknown', start: 0, end: 7 });
  assert.throws(() => api.citeSpans([unknown], { speaker: 'Alex' }), { code: 'SPEAKER_MISMATCH' });
  assert.throws(() => api.formatSpanEvidence(record, { ...first, end: first.end + 1 }), { code: 'INVALID_EVIDENCE' });
});
