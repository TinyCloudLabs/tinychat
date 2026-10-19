# Calendar autojoin operations

Calendar autojoin runs in the existing Tinychat backend. It is off for each user until consent
and a successful primary-calendar probe. The browser importer remains independent after Disable.

## Configuration

- Enable `GOOGLE_MEET_OAUTH_ENABLED` and configure the existing Google client and callback.
- Enable Calendar API in that Google project. Register `calendar.events.owned.readonly`,
  `openid` and `email` alongside the existing Meet, Drive, and Docs scopes. Autojoin requests only
  those three; the Meet, Drive, and Docs scopes belong to the separate Google Meet connect. Complete applicable Google
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

## Existing users after the narrow-scope change

Nothing is revoked or migrated. A user who enabled autojoin earlier keeps the server credential
issued under the old broad grant (Meet, Drive, Docs plus Calendar) until they disconnect or
reconnect; re-enabling issues a Calendar, `openid`, `email` token only. Enabling autojoin no longer
writes the browser's Meet secret or runs a Meet sync, and Meet remains a separate connect. The
disconnect revoke guard is keyed by Google subject and token digests, not by scope, so it applies
to the autojoin and Meet tokens as it did when they were one grant.

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

## Two accounts in the same meeting (TC-581)

ptx runs one bot per Meet, so two connected accounts that auto-join the same meeting must not
both send one. Before a calendar dispatch, the worker takes a per-Meet-link claim (under
`calendar-autojoin/v1/captures/`, keyed by a hash of the normalized link, with the occurrence's
time window). The claim relies on the single writer above; with more than one writer a race falls
through to the ptx backstop below. Dedupe and the states below ship unconditionally.

**Liveness.** Another account's overlapping claim holds this account off only while that
account's bot is actually in, or about to be in, the call: its ptx meeting is `queued`, `joining`,
`waiting_for_admission` or `in_progress`. From `processing` on, the bot has left. An owner that
never got a meeting id counts only until its dispatch cutoff plus one minute. The owner's ptx
status is read before any lock is taken. If the other bot leaves (finished, failed, stopped,
deleted) while this account is still inside its own dispatch window (one minute before start to
five minutes after), this account sends its own bot straight away. Back-to-back meetings in the
same room and last week's occurrence of a recurring meeting never overlap.

**Corroboration.** When an account attaches to another account's capture, it checks its OWN
fresh calendar event for that meeting. The attach is corroborated only if the capturing account's
verified Google email is that event's organizer or an accepted attendee. Otherwise the account
still sends no bot (only one can join), but the attach is **unverified**: it never receives a
transcript, the capturing account's calendar is never read for it, and the Transcriber says "A
TinyCloud notetaker from an account we couldn't match to your invite is already in this meeting"
(`unverified_capture`). This stops an account from putting someone's address on its own event,
joining their room early, and collecting their transcript. Until both accounts have reconnected
for the `email` scope, every collision is unverified.

**Share if on the invite.** With `CALENDAR_AUTOJOIN_SHARING=true` (default off), a corroborated
attach shows "Already being recorded by another TinyCloud account. If you accepted that account's
calendar invite, the transcript will be added..." (`shared_capture_pending`). With the flag off it
shows "Already being recorded by another TinyCloud account. Only one notetaker can join a meeting."
(`capture_in_progress`) and never promises a transcript. When the owner's capture ends, the
worker checks once, server-side, whether the attached account's verified Google email is an
**accepted** attendee on the **owner's own** calendar event for that meeting. If it is, the
recording is added to the attached account's Transcriber list as a "Shared recording": it can read
the transcript and remove the recording from its own list. It cannot end the bot or delete the
owner's recording. Stop and delete reach ptx only when the meeting's `tinychat_address` is the
caller's own address. The owner's address and occurrence id are never sent to the attached
account's browser. Otherwise the attached account sees "Already being recorded" and gets nothing;
it never learns whether or how the owner's capture finished.

The check fails closed when:
- the owner's Google access is revoked or needs a reconnect;
- the owner turned auto-join off;
- the owner's event was cancelled, moved, relinked or deleted;
- Google truncated the guest list;
- the attached account has no verified email.

Storage, network and other non-authorization errors retry until 24 hours after the meeting's
scheduled end, then deny. Email matching is exact and case-insensitive; aliases and `+tag`
addresses do not match. Turning auto-join off while attached returns the occurrence to its normal
lifecycle (no "already handled" marker), so turning it back on inside the window can still send.

- **Verified email.** The email is stored only when Google's ID token marks it verified, and only
  for connections made after the `email` scope was added. Existing connections fail closed until
  the user reconnects Google auto-join.
- **Hidden guest lists.** If the organizer hides the guest list, the owner's copy of the event may
  not list the other account, so the share is denied.
- **ptx backstop.** A bot sent outside this claim (a manual send, or another writer) makes ptx
  fail the second meeting with `meeting_already_captured`. That account's empty meeting is removed
  from its list and deleted upstream, and the occurrence shows "Already being recorded". It is never
  shared.
- There is no revocation after a grant. If the owner deletes the recording upstream, it drops out
  of the other account's list the next time that list loads.
- Logs carry only codes (`share_granted`, `share_denied reason=...`, `shared_capture_attached
  corroborated=...`, `already_captured`), never an email or address.

Accepted limitations:
- **Claim documents.** There is one tiny claim document per distinct auto-joined Meet link. Claims
  are pruned 24 hours after their window ends, on the next write for that link; a link nobody
  auto-joins again keeps its last document. Liveness never trusts a claim alone.
- **Reassigned addresses.** A stale verified email could matter only if a Workspace address is
  reassigned, the new holder accepts the invite, and the stale account has the same Meet on its own
  calendar in an overlapping window. Reconnecting refreshes the stored email.

Rollout: deploy with the flag off, update the consent screen's scope list, have the test accounts
reconnect Google auto-join so their verified email is stored, turn the flag on in dev, prove it
live, then production. Turning the flag off is the rollback; dedupe and corroboration stay on.

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
