# Connector content-key continuity

The backend uses `CONNECTOR_CONTENT_MASTER` for connector content envelopes. The expected commitment is SHA-256 of the trimmed master as UTF-8, matching the read-only admin diagnostic and #637. The backend DID is a separate identity.

## Enrollment

1. Generate the master with a CSPRNG using at least 32 random bytes, encoded as hex or canonical base64. For example, pipe the output of `openssl rand -base64 32` directly into the approved secret manager's stdin input. Supply the value through stdin only: never a command argument, shell variable, terminal output, log, repository file, or chat. The encoding and byte-diversity checks do not establish that a value was generated randomly.
2. For an existing encrypted archive, obtain the live commitment through the authenticated diagnostic and set `CONNECTOR_CONTENT_EXPECTED_SHA256` to that value. Enrollment also requires an existing index to decrypt successfully. A mismatch or unreadable index stops startup.
3. For a fresh installation with no encrypted index or orphan content, set `CONNECTOR_CONTENT_ENROLL_FRESH=true` for exactly **one deploy**. This explicitly permits the first encrypted canary to be created. A supplied expected commitment must match; blank pins are invalid.
4. After that deploy, use `GET /api/ops/content-continuity` with the operator's `x-admin-key` credential. Verify `contentMasterSha256` against the separately recorded expected digest. The backend has verified the persisted canary before making this diagnostic available. The `index` result reports an actual read-only decrypt; an empty installation reports no index, not a successful decrypt.
5. Remove `CONNECTOR_CONTENT_ENROLL_FRESH` from the next deployment's configuration. Keep the same master and expected digest. Subsequent starts verify the existing encrypted canary. Never delete or replace the canary to recover from a failure.

With the master unset, the backend starts only if no canary, encrypted index or orphan content exists. Sealed features remain disabled, enrollment does not run, and the authenticated diagnostic returns `content_master_unset` without a digest. A failed scan or existing sealed data stops startup.

## Singleton scope

Enrollment takes the existing ingest lease before reading the canary or archives. That lease uses read/write/re-read on a KV substrate without conditional put. The deployment remains single-instance; this lease is not an atomic distributed lock. Conditional canary creation and atomic lease acquisition are tracked in [TC-2847](https://linear.app/tinycloud-labs/issue/TC-2847). A continuity failure stops startup; operators investigate the master and persisted records without resetting the baseline.
