# Voice-note storage identity (T18, TC-785 / TC-787)

## Contract (TC-978)

`connector_meeting.source_id` (the recording UUID) is the canonical note identity and the key used by `voice_note_transcript`. `connector_meeting.id` is an opaque row ID: new rows use `vn-<source_id>`, while historical rows may have a bare UUID. Both forms remain valid permanently; readers and cross-surface lookups use `source_id`. Never rewrite existing row IDs.

`voice_note_transcript` is authoritative for committed revisions. If the table is absent or has no row for this `source_id`, no commit exists and readers use the legacy path below. A present row is the latest winner by descending `rev`, then `hash` precedence, as enforced by the commit CAS. For `outcome = 'transcribed'`, read `body_key` only when it has the shape `{APP_ID}/connectors/exo-voice-note/transcript-rev/{source_id}/{32 lowercase hex}`; reject any other value before any KV read. Never let metadata mirrors or the plain body key override it. For `outcome = 'no_speech'`, the pointer names an immutable `[]` body, but the semantic result is **no transcript**: do not return or display an empty transcript or fall back to the plain key.

Only an explicit UI-triggered rerun records the prior revision. After reading the current commit and before committing its replacement, the rerun conditionally creates `{APP_ID}/connectors/exo-voice-note/transcript-history/{source_id}/{rev}` with `ifNoneMatch: "*"`. Its immutable JSON value is `{v:1,rev,hash,body_key,outcome,engine,provider,committed_at}`; the `body_key` keeps the prior immutable body recoverable. If the key already exists, only an identical record is an idempotent success; conflicting content or any other history-write failure aborts the replacement commit, so the prior commit remains authoritative until a new one succeeds. Non-rerun commits are not recorded. Bodies from earlier automatic supersessions remain listable in `transcript-rev`, but those older revisions have no history pointer.

With no commit row, the legacy winner is chosen across `exo-voice-note` and `exo-voice-note-dup` rows whose metadata satisfies `json_valid(metadata) AND transcription_outcome IS NOT NULL`, ordered by `COALESCE(transcribed_at, '') DESC, id ASC` using the stored time string as-is (missing times sort last). TC-976's stored `pending`, `failed`, and `skipped` outcomes are not transcripts, but they still participate in winner ordering; a newer failed row therefore hides an older transcribed duplicate. `none` is the locator's synthetic no-commit result, not a stored outcome. Only a winner with `transcription_outcome = 'transcribed'` is eligible. The metadata fields `transcription_outcome` and `transcript_text` are mirrors written after a verified commit and are ignored whenever a commit row exists.

For an eligible legacy winner, readers compare the plain-key body with `transcript_text` by joining record `text` values with a space, collapsing `\s+` to one space, then trimming both ends. A matching body is timed evidence. If the key is missing, the body is unparseable, or normalized text differs, a non-empty `transcript_text` is untimed evidence. When `transcript_text` is absent or not a string, the app reader returns the plain body unchecked; the standalone pack intentionally fails closed instead of trusting an unvalidated mirror, so agents get a stricter reader. When `transcript_text` is empty and a body exists, the app reader returns an empty untimed transcript; the pack rejects that winner as `not_transcribed`. If the key is missing, the app returns no body and the pack reports a `not_transcribed` omission. The save-time `[]` value is a placeholder, not an empty transcript; a `transcribed` winner without text and with a `[]` body is also a pack `not_transcribed` omission.

This compatibility path assumes only builds predating the commit table (before `b425f3f`, 2026-10-09 UTC) can produce transcribed-but-unindexed notes. The plain key is a non-authoritative, non-atomic legacy mirror: save initializes it to `[]`, then each verified winning commit writes its body there for older readers. There is no CAS ordering the mirror with the SQL commit, so concurrent writes or a failed KV put can leave it stale. Readers consult the plain key only when no commit row exists; writers keep mirroring for older builds. No bulk repair is performed. Any future backfill must publish through `commitVoiceNoteTranscript`.

The voice-note identity gate creates `voice_note_transcript` and then the partial unique index on live `connector_meeting.source_id`. It checks their stored `sqlite_schema` definitions without `PRAGMA`. Duplicate rows are archived, never deleted.

## Live node verification

The live test uses production-line `tinycloud-node-server` 1.19.2 at commit `a10b235`. The published `ghcr.io/tinycloudlabs/tinycloud-node:1.19.2` image has OCI revision `a10b23553a0d46cbbba1155aab6bc601ff284fa1`.

```sh
NODE_REPO=/Users/samgbafa/.paseo/worktrees/2astgp1k/legal-panther/repositories/tinycloud-node
git -C "$NODE_REPO" worktree add --detach /tmp/exo-t18-node-prod a10b235
N=/tmp/exo-t18-node-prod
docker pull --platform linux/amd64 ghcr.io/tinycloudlabs/tinycloud-node:1.19.2
docker image inspect ghcr.io/tinycloudlabs/tinycloud-node:1.19.2 \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
# The checkout's unpinned LocalStack image now requires a license token. For
# this local run, keep the checkout unchanged and pin the community image:
cat > /tmp/exo-t18-localstack.override.yml <<'YAML'
services:
  localstack:
    image: localstack/localstack:4.14.0
YAML
cat > /tmp/exo-t18-r3-node-image.override.yml <<'YAML'
services:
  tinycloud:
    image: ghcr.io/tinycloudlabs/tinycloud-node:1.19.2
YAML
docker compose -f "$N/test/docker-compose.yml" -f /tmp/exo-t18-localstack.override.yml \
  -f /tmp/exo-t18-r3-node-image.override.yml up --no-build -d
# The checkout mounts the old initaws.d path, so create its test bucket directly:
until curl -fsS http://localhost:4566/_localstack/health | rg -q '"s3": "running"'; do sleep 2; done
docker compose -f "$N/test/docker-compose.yml" -f /tmp/exo-t18-localstack.override.yml -f /tmp/exo-t18-r3-node-image.override.yml \
  exec -T localstack awslocal s3api create-bucket --bucket tinycloud-blocks
docker compose -f "$N/test/docker-compose.yml" -f /tmp/exo-t18-localstack.override.yml \
  -f /tmp/exo-t18-r3-node-image.override.yml up --no-build -d tinycloud
until curl -fsS http://localhost:8000/healthz; do sleep 5; done
TINYCLOUD_HOST=http://localhost:8000 bun test test/storage/voice-note-identity.live.test.ts
docker compose -f "$N/test/docker-compose.yml" -f /tmp/exo-t18-localstack.override.yml \
  -f /tmp/exo-t18-r3-node-image.override.yml down -v
```

The test signs in throwaway keys with this repo's `manifest.json`. It observes the identity gate's failed unique-index DDL on seeded duplicates, then checks archival and `merged_at`, the normalized table/index schema, rejected `PRAGMA`, a unique-constraint late insert, idempotent `vn-` and old random-id creates, the audio JSON patch, commit CAS order, positive legacy and committed discovery, and a session without `schema`. A second space runs reconcilers through separate SDK sessions with different observed keeper sets.

Round-3 result at `a10b235` (`tinycloud-node-server` 1.19.2): `2 pass, 0 fail, 41 expect() calls` in `/tmp/exo-t18-r3-v-node.log`. The stale-keeper attempt changed zero rows, leaving `race-c` live until the second session archived it. The SDK emitted non-fatal account-registry 404 warnings during throwaway sign-ins; both SQL/KV test cases passed.


### `transcription_outcome` contract

Allowed values are `pending`, `failed`, `skipped`, `transcribed`, and `no_speech`. For rows with no outcome, readers first honor an authoritative commit or terminal legacy transcript evidence; otherwise they read the row as `pending`. An empty `[]` body without a commit is not transcript evidence. Invalid values are treated as non-terminal hints, not proof of an empty transcript.

Allowed transitions:

- `NULL → pending | skipped` when a row is created. Re-save initialization runs only when the insert did not happen, and only for rows without non-blank legacy `transcript_text`. `skipped` means capture selected transcription `off`.
- `NULL → failed` is allowed only when the row has no non-blank legacy `transcript_text`; `pending | skipped | failed → failed` records a real transcription-attempt failure. Deferrals remain `pending`.
- Any non-terminal outcome → `transcribed | no_speech` only through the transcript commit mirror.
- `transcribed` and `no_speech` never move back to a non-terminal outcome. A higher-revision commit may replace one terminal outcome with the other.
- `sweepArchived` may copy a legacy winner's outcome to the canonical row when repairing archived duplicates; the re-save initialization above also writes an outcome. Both preserve legacy transcript evidence.

The `voice_note_transcript` commit table is authoritative whenever it exists; `connector_meeting.metadata.transcription_outcome` is a compatibility mirror/hint. The public readers also recognize legacy transcript text and the terminal legacy winner when no commit exists. The commit's body key and outcome win over stale metadata.

`transcription_error_code` is meaningful only while `transcription_outcome` is `failed`; ignore a leftover code for any other outcome. It is an error identifier, never an exception message or transcript. Its vocabulary is open for private-cloud/server and audio errors (`PrivateCloudError.code` / `VoiceNoteAudioError.code`; locally defined identifiers include `connection_lost`, `upload_interrupted`, `transcript_save_failed`, and `audio_read_failed`), hosted `AssemblyAiErrorKind` values (`invalid-key`, `network`, `rate-limited`, `rejected`, `failed`, `not-found`), and fixed on-device identifiers (`on_device_transcription_failed`, `on_device_transcript_missing`, `transcript_read_failed`, `transcript_save_failed`). Deferrals `audio_upload_pending`, `transcription_off`, `upload_outcome_unknown`, `account_changed`, and `active_transcription_exists` remain `pending`; retryability of a persisted `failed` outcome depends on its code.

Older builds read unrecognized outcome values as `none` and continue to offer Transcribe; they do not clear `transcription_error_code`. They safely ignore the new non-terminal values, and may leave a stale code after committing a result. The code has no meaning unless the current outcome is `failed`. The fixed transcript key and row metadata remain compatibility mirrors; new readers follow the commit table.

Private transcription may add optional diagnostic metadata: `transcription_audio_seconds`, `transcription_duration_seconds`, `transcription_voiced_seconds`, `transcription_vad_dropped_above_floor_pct`, `transcription_vad_fallback`, and `transcription_stats_missing`. These are mirrors, not transcript outcomes; older builds ignore the unknown JSON keys. `transcription_stats_missing: true` marks a PTX outcome whose duration/audio-seconds pair was not recorded together, so the coverage ratio could not be evaluated; it is also set on PTX's `no_speech` error outcome. This includes duration-only, audio-only, and no-stats results. The no-stats result still commits. Any later commit from this build that does not itself need the marker writes null (which removes the key; readers see it absent), even when it has no stats; a new PTX outcome with an unrecorded pair or a `no_speech` error writes true for that outcome. After a rollback an older build may leave or copy a stale `true` (its archived sweep doesn't strip the key); this is only an extra re-transcription candidate and never drops a transcript. PTX results are retryable `transcript_incomplete` when either finite `dropped_above_floor_pct` is above 10 or the coverage backstop fires (duration at least 600 seconds and audio coverage below 0.35). If the dropped metric is absent, null, or non-finite, only the coverage backstop applies. Without a recorded pair the coverage backstop cannot reject; the finite drop threshold still applies.
These diagnostics describe the attempt that wrote the transcription outcome only when they were written together with that outcome; otherwise they are not evidence about the current outcome.

ptx #93 defines `transcription_vad_dropped_above_floor_pct` as the percentage of non-silent audio (frames at or above −50 dBFS) that was not sent; long silences are excluded from its denominator. Completed post-deploy jobs are expected to report at most 10. `transcription_voiced_seconds` sums across channels, so a separate-stereo job may report more voiced seconds than `transcription_duration_seconds`. `transcription_vad_fallback` is recorded as metadata; it does not suppress either rejection rule. Below-floor loss is not visible to this client guard; TC-1093 tracks the PTX-side quiet-mode stat needed to remove the coverage backstop.

T22 hand-off: after a private-cloud commit, write its committed `(rev, hash)` back to the native `transcriptSync` ledger. This keeps a later on-device transcript in the same revision sequence.

## Device gate G2 (pending release of the Moto)

On Moto debug WebView: toggle airplane mode during a save, `kill -9` the app, relaunch, and inspect raw SQL for one live row per `source_id`, archived siblings, the partial index, and the commit record plus immutable body. Open a Library note with a transcript and confirm meeting chat cites its text. The physical Moto is reserved, so this check remains pending.

Also verify on iOS that `updateLedger` succeeds after `user_choice` claims a v1 sidecar with no pre-existing ledger.
