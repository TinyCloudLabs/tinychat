import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planVoiceNoteBackfill } from '../voice-note-backfill-plan.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';


const audio = new Map([
  ['eligible', { present: true, partCount: 2 }],
  ['failed', { present: true, partCount: 1 }],
  ['body', { present: true, partCount: 1 }],
  ['commit', { present: true, partCount: 1 }],
  ['cap', { present: true, partCount: 1 }],
]);
const row = (source_id, extras = {}) => ({ source_id, duration_secs: 60, bodyHasText: false, ...extras });
const plan = (rows, audioIndex = audio, options = {}) => planVoiceNoteBackfill(rows, audioIndex, { maxSeconds: 7200, ...options });
const audioFor = rows => new Map(rows.map(({ source_id }) => [source_id, { present: true, partCount: 1 }]));
const byId = (results, id) => results.find(result => result.source_id === id);

test('planner classifies every requested outcome with a stable reason', () => {
  const rows = [
    row('eligible'),
    row('terminal-transcribed', { metadata: { transcription_outcome: 'transcribed' } }),
    row('terminal-no-speech', { metadata: { transcription_outcome: 'no_speech' } }),
    row('terminal-skipped', { metadata: { transcription_outcome: 'skipped' } }),
    row('body', { bodyHasText: true }),
    row('commit', { hasTranscriptCommit: true }),
    row('missing-audio'),
    row('cap', { duration_secs: 7201 }),
  ];
  const results = plan(rows);
  assert.deepEqual(results.map(({ source_id, classification }) => [source_id, classification]), [
    ['eligible', 'eligible'],
    ['terminal-transcribed', 'skip-terminal'],
    ['terminal-no-speech', 'skip-terminal'],
    ['terminal-skipped', 'skip-terminal'],
    ['body', 'legacy-body-no-commit'],
    ['commit', 'has-commit'],
    ['missing-audio', 'skip-no-audio'],
    ['cap', 'skip-over-cap'],
  ]);
  for (const result of results) assert.ok(result.reason.length > 0, `${result.source_id} needs a reason`);
});
test('legacy no-outcome captures explicitly set to off are listed as opted out, not eligible', () => {
  const result = byId(plan([row('off', { metadata: {
    capture: { options: { transcriber: 'off' } },
  } })]), 'off');
  assert.equal(result.classification, 'skip-opted-out');
  assert.equal(result.reason, 'capture transcriber was explicitly off');
  assert.equal(result.failedWithCode, false);
});


test('failed outcome with an error code remains eligible and is separately marked', () => {
  const result = byId(plan([row('failed', { metadata: {
    transcription_outcome: 'failed', transcription_error_code: 'PTX_UNAVAILABLE',
  } })]), 'failed');
  assert.equal(result.classification, 'eligible');
  assert.equal(result.failedWithCode, true);
  assert.match(result.reason, /failed/i);
});

test('replanning after a terminal outcome or transcript body is committed drops the note', () => {
  const initial = plan([row('eligible')]);
  assert.equal(initial[0].classification, 'eligible');
  const afterOutcome = plan([row('eligible', { metadata: { transcription_outcome: 'transcribed' } })]);
  assert.equal(afterOutcome[0].classification, 'skip-terminal');
  const afterBody = plan([row('eligible', { bodyHasText: true })]);
  assert.equal(afterBody[0].classification, 'legacy-body-no-commit');
});

test('dry-run CLI refuses write-capable flags before accessing data', () => {
  const script = fileURLToPath(new URL('../voice-note-backfill-dry-run.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--apply'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing write-capable option/);
  assert.doesNotMatch(result.stdout, /"total_rows"/);
});

test('dry-run CLI defaults PTX limits and accepts explicit overrides without a writer', async () => {
  const { parseArgs } = await import('../voice-note-backfill-dry-run.mjs');
  assert.deepEqual(parseArgs([]), {
    profile: 'meeting-digest', maxSeconds: 7200, maxBytes: 120_960_000,
  });
  assert.deepEqual(parseArgs(['--max-seconds', '3600', '--max-bytes', '42']), {
    profile: 'meeting-digest', maxSeconds: 3600, maxBytes: 42,
  });
  assert.throws(() => parseArgs(['--write']), /refusing write-capable option/);
});
test('transcript evidence is resolved commit, legacy winner, fixed body, then row state', () => {
  const results = plan([
    row('commit-first', { hasTranscriptCommit: true, bodyHasText: true }),
    row('archived-winner', {
      metadata: { transcription_outcome: 'pending' },
      legacyWinner: { transcription_outcome: 'transcribed' },
    }),
    row('legacy-text', { metadata: { transcript_text: 'synthetic transcript' } }),
    row('unsafe-body', { bodyHasText: true }),
    row('row-skipped', { metadata: { transcription_outcome: 'skipped' } }),
  ]);
  assert.deepEqual(results.map(({ source_id, classification }) => [source_id, classification]), [
    ['commit-first', 'has-commit'],
    ['archived-winner', 'skip-terminal'],
    ['legacy-text', 'skip-terminal'],
    ['unsafe-body', 'legacy-body-no-commit'],
    ['row-skipped', 'skip-terminal'],
  ]);
  assert.match(results[3].reason, /DO NOT TAP: Transcribe would overwrite a legacy body/);
  assert.doesNotMatch(JSON.stringify(results), /synthetic transcript/);
});

test('v2 non-private notes need the original phone; v1 null options stay eligible', () => {
  const rows = [
    row('v1-null', { metadata: { capture: { version: 1 } } }),
    row('v2-private', { metadata: { capture: { version: 2, options: { transcriber: 'private-cloud' } } } }),
    row('v2-local', { metadata: { capture: { version: 2, options: { transcriber: 'on-device' } } } }),
    row('v2-hosted', { metadata: { capture: { version: 2, options: { transcriber: 'assemblyai' } } } }),
    row('v2-null', { metadata: { capture: { version: 2, options: {} } } }),
  ];
  assert.deepEqual(plan(rows, audioFor(rows)).map(({ classification }) => classification), [
    'eligible', 'eligible', 'needs-original-phone', 'needs-original-phone', 'needs-original-phone',
  ]);
});

test('capture duration fallback is inclusive at the cap', () => {
  const rows = [
    row('fallback-below', { duration_secs: null, metadata: { capture: { duration_ms: 7_199_000 } } }),
    row('fallback-at', { duration_secs: null, metadata: { capture: { duration_ms: 7_200_000 } } }),
    row('fallback-above', { duration_secs: null, metadata: { capture: { duration_ms: 7_201_000 } } }),
  ];
  const results = plan(rows, audioFor(rows));
  assert.deepEqual(results.map(({ classification }) => classification), [
    'eligible', 'eligible', 'skip-over-cap',
  ]);
});

test('parameterized audio MIME is matched by its bare PTX raw type', () => {
  const localAudio = new Map([
    ['webm-over', { present: true, partCount: 4, mimeType: 'audio/webm;codecs=opus', size: 40_000_000 }],
    ['webm-under', { present: true, partCount: 1, mimeType: 'audio/webm; codecs=opus', size: 20_000_000 }],
    ['webm-raw', { present: true, partCount: 1, mimeType: 'audio/webm', size: 80_000_000 }],
    ['raw-over', { present: true, partCount: 1, mimeType: 'audio/mp4', size: 120_960_001 }],
  ]);
  const results = plan([
    row('webm-over', { duration_secs: 4_341 }),
    row('webm-under', { duration_secs: 3_000 }),
    row('webm-raw', { duration_secs: 4_341 }),
    row('raw-over', { duration_secs: 30 }),
  ], localAudio);
  assert.deepEqual(results.map(({ classification }) => classification), [
    'eligible', 'eligible', 'eligible', 'over-ptx-bytes',
  ]);
  assert.equal(results[0].estimatedPtxBytes, 40_000_000);
  assert.equal(results[1].estimatedPtxBytes, 20_000_000);
});

test('non-retryable failures and unusable audio are listed outside eligibility', () => {
  const localAudio = new Map([
    ['busy', { present: true, partCount: 1 }],
    ['bad-manifest', { present: false, classification: 'audio-corrupt', partCount: 0 }],
    ['huge-legacy', { present: false, classification: 'audio-too-large-to-check', partCount: 0 }],
  ]);
  const results = plan([
    row('too-large', { metadata: { transcription_outcome: 'failed', transcription_error_code: 'recording_too_large' } }),
    row('busy', { metadata: { transcription_outcome: 'failed', transcription_error_code: 'service_busy' } }),
    row('bad-manifest'),
    row('huge-legacy'),
  ], localAudio);
  assert.deepEqual(results.map(({ classification, errorCode }) => [classification, errorCode]), [
    ['skip-non-retryable', 'recording_too_large'],
    ['eligible', 'service_busy'],
    ['audio-corrupt', null],
    ['audio-too-large-to-check', null],
  ]);
});

test('audio manifest parser rejects bad shape, part sizes and a wrong total', async () => {
  const { parseAudioManifest } = await import('../voice-note-backfill-plan.mjs');
  const valid = {
    v: 1, mimeType: 'audio/mp4', fileName: 'note.m4a', size: 3, partSize: 2,
    parts: [{ size: 2, etag: '"a"' }, { size: 1, etag: null }],
    sha256: null, createdAt: '2026-01-01T00:00:00.000Z',
  };
  assert.deepEqual(parseAudioManifest(valid), valid);
  assert.equal(parseAudioManifest({ v: 1 }), null);
  assert.equal(parseAudioManifest({ ...valid, parts: [{ size: -1, etag: null }] }), null);
  assert.equal(parseAudioManifest({ ...valid, parts: [{ size: 1, etag: null }] }), null);
});

test('legacy duplicate evidence uses the app winner ordering and canonical dedupe', async () => {
  const { dedupeCanonicalRows, legacyTranscriptWinner } = await import('../voice-note-backfill-plan.mjs');
  const rows = [
    { id: 'z-live', source: 'exo-voice-note', source_id: 'same', metadata: {} },
    { id: 'a-live', source: 'exo-voice-note', source_id: 'same', metadata: { transcription_outcome: 'pending' } },
    { id: 'dup-old', source: 'exo-voice-note-dup', source_id: 'same',
      metadata: { transcription_outcome: 'transcribed', transcribed_at: '2026-01-01' } },
    { id: 'dup-new', source: 'exo-voice-note-dup', source_id: 'same',
      metadata: { transcript_text: 'synthetic words', transcribed_at: '2026-02-01' } },
  ];
  assert.deepEqual(dedupeCanonicalRows(rows).map(({ id }) => id), ['a-live']);
  assert.equal(legacyTranscriptWinner(rows).id, 'dup-new');
  assert.equal(legacyTranscriptWinner(rows).metadata.transcript_text, 'synthetic words');
});
test('read-only snapshot resolves evidence, dedupes live rows, and redacts text', async () => {
  const { collectVoiceNoteBackfillReport } = await import('../voice-note-backfill-report.mjs');
  const audioPrefix = 'xyz.tinycloud.tinychat/connectors/exo-voice-note/audio';
  const transcriptPrefix = 'xyz.tinycloud.tinychat/connectors/exo-voice-note/transcript';
  const meetings = [
    { id: 'z-live', source: 'exo-voice-note', source_id: 'dup', duration_secs: 60, metadata: {} },
    { id: 'a-live', source: 'exo-voice-note', source_id: 'dup', duration_secs: 60,
      metadata: { transcription_outcome: 'pending' } },
    { id: 'dup-text', source: 'exo-voice-note-dup', source_id: 'dup', duration_secs: 60,
      metadata: { transcript_text: 'SYNTHETIC_TRANSCRIPT_SECRET', transcribed_at: '2026-02-01' } },
    { id: 'unsafe-body', source: 'exo-voice-note', source_id: 'unsafe-body', duration_secs: 60,
      metadata: { capture: { version: 1, options: { transcriber: null } } } },
    { id: 'committed-body', source: 'exo-voice-note', source_id: 'committed-body', duration_secs: 60, metadata: {} },
    { id: 'v1-null', source: 'exo-voice-note', source_id: 'v1-null', duration_secs: null,
      metadata: { platform: 'android', capture: { version: 1, source: 'in_app', duration_ms: 120_000 } } },
    { id: 'nonretryable', source: 'exo-voice-note', source_id: 'nonretryable', duration_secs: 10,
      metadata: { transcription_outcome: 'failed', transcription_error_code: 'recording_too_large' } },
    { id: 'v2-top-level', source: 'exo-voice-note', source_id: 'v2-top-level', duration_secs: 60,
      metadata: { transcriber: 'private-cloud', capture: { version: 2 } } },
  ];
  const values = new Map();
  const putManifest = (id, mimeType, size) => {
    const base = `${audioPrefix}/${id}`;
    values.set(`${base}/manifest`, JSON.stringify({
      v: 1, mimeType, fileName: 'synthetic', size, partSize: size,
      parts: [{ size, etag: null }], sha256: null, createdAt: '2026-01-01',
    }));
    values.set(`${base}/p/000000`, Buffer.alloc(size));
  };
  putManifest('unsafe-body', 'audio/mp4', 2);
  putManifest('committed-body', 'audio/mp4', 2);
  putManifest('v1-null', 'audio/mpeg', 2);
  putManifest('v2-top-level', 'audio/mp4', 2);
  values.set(`${transcriptPrefix}/unsafe-body`, Buffer.from('SYNTHETIC_LEGACY_BODY_SECRET'));
  values.set(`${transcriptPrefix}/committed-body`, Buffer.from('SYNTHETIC_COMMITTED_BODY_SECRET'));
  const queryCalls = [];
  const result = (columns, rows) => ({ columns, rows: rows.map(row => columns.map(column => row[column] ?? null)) });
  const report = collectVoiceNoteBackfillReport({
    sqlQuery(sql) {
      queryCalls.push(sql);
      if (sql.includes('sqlite_schema')) return result(['name'], [{ name: 'voice_note_transcript' }]);
      if (sql.includes('FROM voice_note_transcript')) return result(['source_id'], [{ source_id: 'committed-body' }]);
      return result(['id', 'source', 'source_id', 'duration_secs', 'metadata'], meetings);
    },
    kvList(prefix) { return [...values.keys()].filter(key => key.startsWith(prefix)); },
    kvGet(key) { return values.get(key); },
  });
  assert.equal(report.total_rows, 6, 'duplicate live row is collapsed to the post-identity keeper');
  assert.equal(report.counts['skip-terminal'], 1);
  assert.equal(report.counts['legacy-body-no-commit'], 1);
  assert.equal(report.counts['has-commit'], 1);
  assert.equal(report.counts['skip-non-retryable'], 1);
  assert.deepEqual(report.do_not_tap.map(({ source_id }) => source_id), ['unsafe-body']);
  assert.equal(report.eligible[0].source_id, 'v1-null');
  assert.equal(report.eligible[0].duration_secs, 120);
  assert.equal(report.eligible[0].platform, 'android');
  assert.equal(report.eligible[0].capture_version, 1);
  assert.equal(report.eligible[0].transcriber_option, null);
  assert.equal(report.eligible[0].mime_type, 'audio/mpeg');
  assert.equal(report.eligible[0].audio_present, true);
  assert.equal(report.eligible[0].part_count, 1);
  assert.equal(report.eligible[0].plain_body_bytes, 0);
  assert.equal(report.eligible[0].manifest_size_bytes, 2);
  assert.equal(report.notes.find(note => note.source_id === 'nonretryable').error_code, 'recording_too_large');
  const topLevelTranscriber = report.notes.find(note => note.source_id === 'v2-top-level');
  assert.equal(topLevelTranscriber.transcriber_option, null);
  assert.equal(topLevelTranscriber.classification, 'needs-original-phone');
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_(TRANSCRIPT|LEGACY_BODY|COMMITTED_BODY)_SECRET/);
  assert.ok(queryCalls.some(sql => sql.includes('sqlite_schema')));
});

test('absent commit table is read-only and treated as no commits', async () => {
  const { collectVoiceNoteBackfillReport } = await import('../voice-note-backfill-report.mjs');
  let commitRowsQueried = false;
  const report = collectVoiceNoteBackfillReport({
    sqlQuery(sql) {
      if (sql.includes('sqlite_schema')) return { columns: ['name'], rows: [] };
      if (sql.includes('FROM voice_note_transcript')) {
        commitRowsQueried = true;
        throw new Error('table must not be queried when absent');
      }
      return { columns: ['id', 'source', 'source_id', 'duration_secs', 'metadata'],
        rows: [['only', 'exo-voice-note', 'only', 60, '{}']] };
    },
    kvList() { return []; },
    kvGet() { throw new Error('no keys in synthetic storage'); },
  });
  assert.equal(commitRowsQueried, false);
  assert.equal(report.counts['skip-no-audio'], 1);
  assert.equal(report.total_rows, 1);
});

test('malformed manifest and legacy maxBuffer overflow become row classifications', async () => {
  const { collectVoiceNoteBackfillReport } = await import('../voice-note-backfill-report.mjs');
  const audioPrefix = 'xyz.tinycloud.tinychat/connectors/exo-voice-note/audio';
  const malformedKey = `${audioPrefix}/corrupt/manifest`;
  const hugeLegacyKey = `${audioPrefix}/huge`;
  const report = collectVoiceNoteBackfillReport({
    sqlQuery(sql) {
      if (sql.includes('sqlite_schema')) return { columns: ['name'], rows: [] };
      if (sql.includes('FROM voice_note_transcript')) throw new Error('unexpected query');
      return { columns: ['id', 'source', 'source_id', 'duration_secs', 'metadata'], rows: [
        ['corrupt', 'exo-voice-note', 'corrupt', 60, '{}'],
        ['huge', 'exo-voice-note', 'huge', 60, '{}'],
      ] };
    },
    kvList(prefix) {
      if (prefix === `${audioPrefix}/`) return [malformedKey, hugeLegacyKey];
      return [];
    },
    kvGet(key) {
      if (key === malformedKey) return Buffer.from(JSON.stringify({
        v: 1, mimeType: 'audio/mp4', fileName: 'bad', size: 3, partSize: 1,
        parts: [{ size: 1, etag: null }, { size: 1, etag: null }],
        sha256: null, createdAt: '2026-01-01',
      }));
      const error = new Error('synthetic overflow');
      error.code = 'ENOBUFS';
      throw error;
    },
  });
  assert.equal(report.counts['audio-corrupt'], 1);
  assert.equal(report.counts['audio-too-large-to-check'], 1);
});

test('legacy single-value audio uses the exact base key and reports byte sizes', async () => {
  const { collectVoiceNoteBackfillReport, AUDIO_PREFIX } = await import('../voice-note-backfill-report.mjs');
  const key = `${AUDIO_PREFIX}/legacy`;
  const output = { mimeType: 'audio/mpeg', base64: Buffer.from([1, 2, 3]).toString('base64') };
  const report = collectVoiceNoteBackfillReport({
    sqlQuery(sql) {
      if (sql.includes('sqlite_schema')) return { columns: ['name'], rows: [] };
      return {
        columns: ['id', 'source', 'source_id', 'duration_secs', 'metadata'],
        rows: [['legacy-row', 'exo-voice-note', 'legacy', 3, JSON.stringify({ capture: { version: 1 } })]],
      };
    },
    kvList(prefix) { return prefix === `${AUDIO_PREFIX}/` ? [key] : []; },
    kvGet(requestedKey) {
      assert.equal(requestedKey, key);
      return Buffer.from(JSON.stringify(output));
    },
  });
  assert.equal(report.eligible[0].audio_key_shape, 'legacy-base-value');
  assert.equal(report.eligible[0].audio_present, true);
  assert.equal(report.eligible[0].part_count, 1);
  assert.equal(report.eligible[0].audio_size_bytes, 3);
  assert.equal(report.eligible[0].legacy_key_bytes, Buffer.byteLength(JSON.stringify(output)));
  assert.equal(report.eligible[0].manifest_size_bytes, null);
});
