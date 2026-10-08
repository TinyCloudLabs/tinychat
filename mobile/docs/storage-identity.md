# Voice-note storage identity (T18, TC-785 / TC-787)

The voice-note identity gate creates `voice_note_transcript` and then the partial unique index on live `connector_meeting.source_id`. It checks their stored `sqlite_schema` definitions without `PRAGMA`. Duplicate rows are archived, never deleted. The commit table is the transcript authority; immutable bodies live under `exo-voice-note/transcript-rev/`.

## Live node verification

The live test uses production-line `tinycloud-node-server` 1.19.2 at commit `a10b235`.

```sh
NODE_REPO=/Users/samgbafa/.paseo/worktrees/2astgp1k/legal-panther/repositories/tinycloud-node
git -C "$NODE_REPO" worktree add --detach /tmp/exo-t18-node-prod a10b235
N=/tmp/exo-t18-node-prod
# The checkout's unpinned LocalStack image now requires a license token. For
# this local run, keep the checkout unchanged and pin the community image:
cat > /tmp/exo-t18-localstack.override.yml <<'YAML'
services:
  localstack:
    image: localstack/localstack:4.14.0
YAML
docker compose -f "$N/test/docker-compose.yml" -f /tmp/exo-t18-localstack.override.yml up --build -d
# The checkout mounts the old initaws.d path, so create its test bucket directly:
until curl -fsS http://localhost:4566/_localstack/health | rg -q '"s3": "running"'; do sleep 2; done
docker compose -f "$N/test/docker-compose.yml" -f /tmp/exo-t18-localstack.override.yml \
  exec -T localstack awslocal s3api create-bucket --bucket tinycloud-blocks
docker compose -f "$N/test/docker-compose.yml" -f /tmp/exo-t18-localstack.override.yml up -d tinycloud
until curl -fsS http://localhost:8000/healthz; do sleep 5; done
TINYCLOUD_HOST=http://localhost:8000 bun test test/storage/voice-note-identity.live.test.ts
docker compose -f "$N/test/docker-compose.yml" -f /tmp/exo-t18-localstack.override.yml down -v
```

The test signs in throwaway keys with this repo's `manifest.json`. It observes the identity gate's failed unique-index DDL on seeded duplicates, then checks archival and `merged_at`, the normalized table/index schema, rejected `PRAGMA`, a unique-constraint late insert, idempotent `vn-` and old random-id creates, the audio JSON patch, commit CAS order, positive legacy and committed discovery, and a session without `schema`. A second space runs reconcilers through separate SDK sessions with different observed keeper sets.

Result at `a10b235` (`tinycloud-node-server` 1.19.2): `2 pass, 0 fail, 39 expect() calls` in `/tmp/exo-t18-v-node-prod-r2.log`. The SDK emitted a non-fatal account-registry 404 warning during one throwaway sign-in; both SQL/KV test cases passed. The first live attempt had `1 pass, 1 fail` because the test's observed-set recorder overwrote its first snapshot with a later empty result; the corrected rerun is the result above.

The transcript commit table is authoritative. The fixed transcript key and `connector_meeting` transcript metadata are legacy mirrors, and writes from two devices can leave a mirror on an older revision. Readers follow the committed body key. The identity layer classifies a full-space growth rejection as `storage_full` (unit tested); the recording stays on the phone for retry after space is freed.

## Device gate G2 (pending release of the Moto)

On Moto debug WebView: toggle airplane mode during a save, `kill -9` the app, relaunch, and inspect raw SQL for one live row per `source_id`, archived siblings, the partial index, and the commit record plus immutable body. Open a Library note with a transcript and confirm meeting chat cites its text. The physical Moto is reserved, so this check remains pending.
