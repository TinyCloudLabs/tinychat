# Voice-note storage identity (T18, TC-785 / TC-787)

The voice-note identity gate creates `voice_note_transcript` and then the partial unique index on live `connector_meeting.source_id`. It checks their stored `sqlite_schema` definitions without `PRAGMA`. Duplicate rows are archived, never deleted. The commit table is the transcript authority; immutable bodies live under `exo-voice-note/transcript-rev/`.

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
