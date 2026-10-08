# Voice-note storage identity (T18, TC-785 / TC-787)

The voice-note identity gate creates `voice_note_transcript` and then the partial unique index on live `connector_meeting.source_id`. It checks their stored `sqlite_schema` definitions without `PRAGMA`. Duplicate rows are archived, never deleted. The commit table is the transcript authority; immutable bodies live under `exo-voice-note/transcript-rev/`.

## Live node verification

Node checkout: `/Users/samgbafa/.paseo/worktrees/2astgp1k/legal-panther/repositories/tinycloud-node`, commit `458137c`.

```sh
N=/Users/samgbafa/.paseo/worktrees/2astgp1k/legal-panther/repositories/tinycloud-node
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

The test signs in a throwaway key with this repo's `manifest.json`, then checks duplicate archival, the normalized table/index schema, rejected `PRAGMA`, a late duplicate insert, commit CAS order, discovery, and a second session whose connector grant lacks `schema`.

Result on node checkout `458137c`: **1 pass, 0 fail, 17 assertions** (`/tmp/exo-t18-v-node-postmemo.log`; rerun after the final identity-memo change). The signed test confirmed both DDL definitions, rejected `PRAGMA`, duplicate archival and a concurrent reconcile, the partial index's rejection of a late insert, commit CAS including equal revisions, discovery with read authority, and `needs_authorization` without the schema grant. The first build ran out of Docker image space while extracting LocalStack; `docker builder prune -f` reclaimed 16.97 GB of build cache. The unpinned `localstack/localstack:latest` then exited with code 55 because it required `LOCALSTACK_AUTH_TOKEN`. The temporary pin to `4.14.0` and manual bucket creation above let the node start. Neither change was made to the sibling checkout.

## Device gate G2 (pending release of the Moto)

On Moto debug WebView: toggle airplane mode during a save, `kill -9` the app, relaunch, and inspect raw SQL for one live row per `source_id`, archived siblings, the partial index, and the commit record plus immutable body. Open a Library note with a transcript and confirm meeting chat cites its text. The physical Moto is reserved, so this check remains pending.
