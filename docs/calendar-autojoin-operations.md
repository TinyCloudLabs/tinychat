# Calendar autojoin operations

Calendar autojoin runs in the existing Tinychat backend. It is off for each user until consent
and a successful primary-calendar probe. The browser importer remains independent after Disable.

## Configuration

- Enable `GOOGLE_MEET_OAUTH_ENABLED` and configure the existing Google client and callback.
- Enable Calendar API in that Google project. Register `calendar.events.owned.readonly` and
  `openid` alongside the existing Meet, Drive, and Docs scopes. Complete applicable Google
  publishing and verification requirements; Testing refresh tokens commonly last seven days.
  See Google's [Calendar authorization scopes](https://developers.google.com/workspace/calendar/api/auth)
  and [refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).
- Set `TRANSCRIPTION_API_URL`, `TRANSCRIPTION_API_KEY`, and a strong persistent
  `CONNECTOR_CREDENTIAL_MASTER`. Existing browser-only Google connections work without custody;
  the autojoin routes are available only when all three dependencies are present.
- Deploy the transcription change providing project-authenticated
  `GET /v1/meetings/by-idempotency-key` before enabling autojoin. Include `google_meet` in that
  service's `ENABLED_PLATFORMS`.
- Backend KV must persist across restarts and support prefix listing. Startup verifies listing.
  Store credentials and the encryption master durably. Do not rotate away the only decrypting key.

## Single writer and replacement

There must be exactly **one backend process writing this TinyCloud backend space**. The existing
KV lease has no compare-and-set and does not make overlapping instances safe. Do not scale out or
perform rolling replacements. Stop the old instance, wait for it to exit, then start its replacement.
This also applies to HTTP writes, including OAuth, disable, and the recording ownership index.

SIGTERM stops new scheduling and new HTTP connections, then drains both before exiting. Compose
allows 130 seconds for this drain. A timeout exits with failure; wait for the old process to be gone
before starting the replacement. Persisted unknown outcomes are looked up at startup, including
after the join window has ended. Never purge them to make the queue look empty.

The timer ticks every 30 seconds. Calendar discovery runs roughly once a minute, capped at 500
events; an incomplete scan suppresses new dispatches until a complete scan succeeds. Four external
operations can run concurrently, with at most one dispatch per tenant. Retry-After delays are kept
in full even when they exceed the ordinary 15-minute retry backoff limit.

## Storage and retention

Connection and occurrence keys live under `calendar-autojoin/v1/`; secrets use the encrypted
`google-calendar` credential namespace. Disabled connections remain discoverable while old work
is unresolved. Sent markers have no expiry, survive recording deletion and reconnect, and must
not be swept with ordinary expired occurrence records. Resolved detail rows are retained 30 days.

Library import happens when the user's storage session is unlocked. Completion requires both
the SQL meeting and its transcript KV body, including an explicit empty array for a valid empty
transcript. A partial write is repaired on return or on a subsequent open-app retry. Server-side
delegations are not used to write the user's library.

Source inspection of the transcription revision used for this change finds explicit meeting
deletion, not an age-based transcript expiry job. **Deployed retention has not been verified**:
before release, check the deployed database, provider, backups, and any external cleanup jobs so
owned recordings/transcripts remain retrievable until explicitly deleted. Do not promise recovery
through a deployment that removes the only stored transcript before a user returns.

## Test-account smoke

Unit/integration tests cover state transitions; they do not establish live Google consent or host
admission. In a configured test account:

1. Connect Google, enable autojoin with custody consent, and verify a successful scan.
2. Create an accepted timed Meet on the primary calendar. Close the browser before its start.
   Confirm the bot requests entry from 60 seconds before start; admit it and speak a short phrase.
3. Reopen the app and unlock storage. Verify one owned recording imports with Calendar title/start
   and a transcript; navigate away from Sources during import and verify it still completes.
4. Test Disable during an active or uncertain send. Confirm new sends stop, the active/recovered
   bot stops, and existing recordings remain. Re-enable must not clear that old stop intent.
5. Test cancellation/reschedule, same-account reconnect, different-account reconnect, and
   Disconnect. Confirm ordinary importer access remains after Disable and local secrets are
   removed on Disconnect, including when Google revocation reports failure.

Live smoke, production configuration, and deployed retention checks are not performed by the
automated test suite and must be recorded separately when exercised.
