# Voice-note storage identity (T18, TC-785 / TC-787)

## Contract (TC-978)

`connector_meeting.source_id` (the recording UUID) is the canonical note identity and the key used by `voice_note_transcript`. `connector_meeting.id` is an opaque row ID: new rows use `vn-<source_id>`, while historical rows may have a bare UUID. Both forms remain valid permanently; readers and cross-surface lookups use `source_id`. Never rewrite existing row IDs.

`voice_note_transcript` is authoritative for committed revisions. If the table is absent or has no row for this `source_id`, no commit exists and readers use the legacy path below. A present row is the latest winner by descending `rev`, then `hash` precedence, as enforced by the commit CAS. For `outcome = 'transcribed'`, read `body_key` only when it has the shape `{APP_ID}/connectors/exo-voice-note/transcript-rev/{source_id}/{32 lowercase hex}`; reject any other value before any KV read. Never let metadata mirrors or the plain body key override it. For `outcome = 'no_speech'`, the pointer names an immutable `[]` body, but the semantic result is **no transcript**: do not return or display an empty transcript or fall back to the plain key.

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

The transcript commit table is authoritative. The fixed transcript key and `connector_meeting` transcript metadata are legacy mirrors, and writes from two devices can leave a mirror on an older revision. Readers follow the committed body key. The identity layer classifies a full-space growth rejection as `storage_full` (unit tested); the recording stays on the phone for retry after space is freed.

T22 hand-off: after a private-cloud commit, write its committed `(rev, hash)` back to the native `transcriptSync` ledger. This keeps a later on-device transcript in the same revision sequence.

## Device gate G2 (pending release of the Moto)

On Moto debug WebView: toggle airplane mode during a save, `kill -9` the app, relaunch, and inspect raw SQL for one live row per `source_id`, archived siblings, the partial index, and the commit record plus immutable body. Open a Library note with a transcript and confirm meeting chat cites its text. The physical Moto is reserved, so this check remains pending.

Also verify on iOS that `updateLedger` succeeds after `user_choice` claims a v1 sidecar with no pre-existing ledger.
