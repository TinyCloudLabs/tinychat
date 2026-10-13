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
const plan = rows => planVoiceNoteBackfill(rows, audio, { maxSeconds: 7200 });
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
    ['body', 'skip-has-body'],
    ['commit', 'skip-has-commit'],
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
  assert.equal(afterBody[0].classification, 'skip-has-body');
});

test('dry-run CLI refuses write-capable flags before accessing data', () => {
  const script = fileURLToPath(new URL('../voice-note-backfill-dry-run.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--apply'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing write-capable option/);
  assert.doesNotMatch(result.stdout, /"total_rows"/);
});
