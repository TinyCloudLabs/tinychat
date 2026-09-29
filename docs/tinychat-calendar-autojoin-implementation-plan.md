> Historical implementation plan. The feature is now implemented; see [implementation status](calendar-autojoin-implementation.md) and [local testing](calendar-autojoin-local-testing.md).

Implementation plan · 25 September 2026

# Google Calendar autojoin

Add a small reconciliation worker to Tinychat's existing backend. It reads eligible primary-calendar occurrences, records durable dispatch intent, and starts the existing transcription bot. Capture runs with the browser closed; the library catches up when the user returns.

Tinychat `f67bf084` · Transcription `2cdaabd4` · Planning only; implementation has not begun.

## One practical approach

Reuse backend TinyCloud KV, the encrypted credential store, recording ownership index, and transcription service. Run reconciliation at startup and every 30 seconds; refresh each enabled calendar about once a minute, with jitter. A timer wakes work; persisted records determine what happens. Add one read-only transcription lookup for uncertain creates. No new deployed service, database, Redis, Calendar watch channels, or background delegation into user storage.

1. **Discover** — Primary calendar, next 24 hours.
2. **Remember** — Occurrence and exact dispatch intent.
3. **Recheck** — Current event, policy, and time.
4. **Dispatch** — Existing bot API; recover ownership.
5. **Import** — User returns and unlocks the library.

## Initial behavior

These are the proposed defaults; none requires another product decision before implementation.

| Area | Chosen behavior |
| --- | --- |
| Scope and consent | Off by default. One Google connection, primary calendar only. Enable explicitly authorizes unattended calendar reading and encrypted server storage of the Google refresh token. |
| Attendance | Confirmed, timed Google Meet events where the user is organizer or the self attendee has accepted. An explicit declined/tentative/needsAction self response excludes the event. Skip all-day, cancelled, tentative, and non-Meet events. Private events follow the same rule. |
| Timing | Send from 60 seconds before start until `min(start + 5 minutes, end)`, exclusive. Recovery follows this same window. A missed occurrence gets a visible reason, not a much later bot. |
| Changes | Before any create attempt, reschedules and new links update the pending occurrence. Once create may have happened, never send a replacement for that occurrence. Resolve its outcome and stop any existing bot if cancelled, moved, link-changed, or attendance becomes ineligible. |
| Disable / disconnect | Both immediately block new sends and queue stops for active autojoined bots. Disable deletes server credentials but preserves the browser Google importer. Disconnect additionally revokes the Google grant and removes the browser token. Preserve recordings and ownership. |
| UI | One toggle in the existing Google connector, a short attendance/timing explanation, last successful scan, and Off / On / Needs reconnect / Error status. Show missed/failed outcomes beside existing recordings. Keep Google's automatic-transcription setting separately labelled. |

Independent occurrences can each send a bot, including overlapping events. Manual bot creation remains independent; this version does not merge recordings across users, manual starts, or Google's transcript importer. Autojoin requests admission; it cannot guarantee the host accepts the bot.

## Authorization and one-account lifecycle

Extend the existing PKCE popup for the autojoin purpose only. Preserve Meet/Drive/Docs permissions; add `calendar.events.owned.readonly` and `openid`, with offline access and incremental authorization. The narrower Calendar scope reads events on calendars the user owns, including invitations on their primary calendar; both required event methods support it. It is not restricted to events the user organizes, nor exclusively to the primary calendar. Primary-only is our application policy. [Scopes](https://developers.google.com/workspace/calendar/api/auth) · [List authorization](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) · [Get authorization](https://developers.google.com/workspace/calendar/api/v3/reference/events/get).

`openid` supplies a stable Google subject for reconnect and account-switch detection, without requesting profile/email data or building an account registry. Validate the ID token with a standard Google/OIDC library, including signature, issuer, audience, expiry, and transaction nonce. Bind the OAuth transaction to the authenticated Tinychat tenant, purpose, and consent. Read granted scopes from Google's exchange response and verify Calendar access server-side; never trust browser-submitted scope strings. [Google identity reference](https://developers.google.com/identity/openid-connect/openid-connect).

After explicit consent, persist an `enabling` record before storing the encrypted server credential. Update the browser's existing secret from the same exchange, then finalize enable after a primary-calendar probe succeeds. Interrupted setup remains disabled and retryable; abandoned enabling records clean up their credential. No usable refresh token means setup is incomplete. [Offline authorization](https://developers.google.com/identity/protocols/oauth2/web-server).

Same-subject reconnect preserves occurrence identities. Account replacement first persists disabled scheduling and stop intent for old attempts, then allows the new connection without waiting for upstream resolution. Old attempts continue lookup, ownership repair, and stop recovery in their original subject namespace; a lookup that keeps returning not found must not block replacement. A different subject gets a separate identity namespace. Ordinary browser reconnect also disables autojoin until explicitly rebound, preventing browser and server from silently following different accounts. Re-enable repeats custody consent. Keep consent copy truthful after Disable: the Google grant may retain Calendar permission although server custody has ended.

Use a Google-specific instance of `CredentialStore`, sharing its encrypted row store and storage lane, not Fireflies' provider-specific revoker. Refresh without a browser, persist rotated refresh tokens, and retain the previous token if no replacement is returned. Disable/account replacement increments the connection generation and clears cached tokens; late refresh results must recheck that generation before writing, so disconnect cannot resurrect a credential. Permanent authorization loss blocks dispatch and shows Needs reconnect; recording lookup, ownership repair, and requested stops continue using the transcription project key.

## Minimal persistent state

| Record | Fields and retention |
| --- | --- |
| Connection | Tenant, Google subject, enabled/setup state, connection generation, consent time, Google-confirmed scopes, credential reference, next/last scan, fixed error code. Enumerate the backend KV connection prefix, including disabled tenants with unresolved work. Secrets live only in the credential store. |
| Occurrence | Stable identity, current Google event ID, start/end, normalized Meet URL, phase, next attempt/count. When dispatch starts, add the connection generation, frozen create body, idempotency key, eventual meeting ID, and persistent `stopRequested` flag. Phases: pending, outcome unknown, ownership pending, sent, stop pending, terminal. |
| Sent marker | A compact opaque identity plus recording ID/disposition after resolution. Retain through reconnect, far-future reschedules, and recording deletion; no 30-day dedupe expiry. Purge ordinary expired unsent rows, but never discard unresolved attempts merely because the meeting ended. Full account deletion can remove these records. |

Identity is a hash of an unambiguous tuple: `[version, tenant, Google subject, "primary", event.id]` for a single event; use `[recurringEventId, originalStartTime]` instead of `event.id` for a recurring instance. Canonicalize the original timestamp to the same UTC instant. Current start time and meeting URL are mutable fields, never identity. Google's [recurrence semantics](https://developers.google.com/workspace/calendar/api/guides/recurringevents) preserve the original occurrence across moves.

Use separate occurrence keys and the existing shared `BackendStorageLane` for read-modify-write operations. Keep only needed metadata, not descriptions or attendee lists. Compact resolved payloads after ownership is secure; useful title/start metadata remains with the recording. Opaque sent markers grow with dispatched occurrences—this small retention cost prevents reschedules from rejoining old events.

## Reconciliation and recovery

1. **Discover.** List `primary` with `singleEvents=true`, `showDeleted=true`, `timeMin=now−5m`, and `timeMax=now+24h`; paginate. Remember that timeMin filters event end, so apply our own start/end policy. Accept a valid HTTPS `meet.google.com` video entry or `hangoutLink` fallback. A missing bounded-list result is not proof of cancellation. Refetch known due occurrences individually, including ones moved outside the scan window. [Event fields](https://developers.google.com/workspace/calendar/api/v3/reference/events).
2. **Freeze intent before network dispatch.** Store a deterministic idempotency key and exact create payload: URL, platform, resolved bot name, tenant attribution, occurrence identity, title, and scheduled start. A failed state write means no POST. Retries reuse identical values, including metadata and defaults.
3. **Check immediately before every POST.** Fetch the current event, confirm the frozen link/time still match, then reread enabled state, dispatch generation, stop intent, and current time under the same-process tenant coordination used by disable/reconnect. An old-generation or stop-requested attempt must never POST again. Ineligible, ended, stale, or unverifiable events do not send. Disable the client's hidden transport retry for scheduler calls; retries must pass this check too. Keep network I/O outside the global storage lane. Google edits after submission cannot be atomic with our request; subsequent reconciliation compensates with stop.
4. **Resolve uncertainty without creating.** Add a project-authenticated `GET /v1/meetings/by-idempotency-key` lookup accepting the key in a header and using the existing unique database index. Return the existing meeting and request hash, or not found; never enqueue. Tinychat verifies hash and tenant metadata before accepting it. On lost responses/restart, lookup first. POST again only while currently eligible with unchanged frozen payload. After cutoff, cancellation, disable, or credential loss, perform lookup only.
5. **Do not turn a lookup miss into a false conclusion.** An older timed-out request may still commit. Retain an unknown-outcome row and perform low-rate lookups with capped backoff; no fresh key or replacement bot. If found after dispatch became ineligible, secure ownership and request stop. A request timeout is not cancellation of the upstream operation.
6. **Repair ownership.** Persist the recovered/returned recording ID first, then repeat the existing idempotent `index.add(tenant, id)` until successful. Keep ownership-pending state across restart and Google disconnect. All user read/stop/delete/transcript routes retain the existing ownership checks. Once an ID is known, never call create again for that occurrence.

Poll nonterminal recordings and their Calendar events about once a minute while credentials permit. Cancellation, start/link change, or attendance withdrawal requests stop; reaching the scheduled end alone leaves normal capture lifecycle to the transcription service. Continue recording/stop reconciliation until terminal, including after event end. Disable is persisted before acknowledgement; already submitted creates may finish, then are recovered and stopped. Persist stop intent even while the recording ID is unknown. Re-enable never clears that intent or makes an old-generation attempt eligible again; a later lookup hit still requires ownership repair and stop. Failed revoke is reported and local credential copies are still removed.

The existing service already provides [project-scoped create idempotency](https://github.com/TinyCloudLabs/tinycloud-private-transcription/blob/2cdaabd43ab43cfd8cf714f0045d8f01415926d6/src/services/meetings.ts#L35). The new lookup closes the gap between “retry safely while eligible” and “recover after sending is forbidden”; it needs no schema migration or scheduling feature.

## Bounded operation and deployment

Allow four external operations concurrently, at most one dispatch per tenant, and no overlapping reconciliation tick. Bound a discovery scan to 500 events; on overflow/incomplete pagination show a fixed error and suppress newly discovered dispatches until a complete scan succeeds. Existing recording recovery continues. Do not interpret truncated data as deletions.

Retry transport failures, 5xx, 429, and Google 403 rate-limit reasons with jitter. Persist the next attempt; respect the full Retry-After delay. Allow two immediate retries, then defer with exponential backoff capped at 15 minutes, always clipping creates to their eligibility window. A 401 gets one refresh; insufficient scope, invalid grant, or genuine access denial requires reconnect. Capacity rejection follows the same bounded create policy; after an ID exists, existing provider/admission retries own capture. Show failures instead of repeatedly spawning replacement bots. Log fixed codes, counts, and opaque IDs; never credentials, raw request bodies, event titles, or meeting links.

**One backend writer is an explicit v1 deployment requirement.** Stop and drain the old backend, including HTTP writes, before starting its replacement. Startup reconciliation covers the short gap. The current [KV lease lacks compare-and-set](https://github.com/TinyCloudLabs/tinychat/blob/f67bf08417c8954fc0bab4379e99db13977f4d96/backend/src/services/ingest-instance.ts#L11); it may detect overlap, but cannot protect policy or ownership writes. Do not add an ownership-index migration to simulate distributed safety. If the deployment cannot provide nonoverlap, reliable shared transactional/CAS storage becomes a real prerequisite; upstream idempotency alone does not solve lost KV writes.

## Implementation order and focused validation

| Step / files | Work and evidence required |
| --- | --- |
| 1. Dispatch API seam | `transcription-api.ts`: optional stable key and scheduler-controlled retries; preserve manual defaults. Transcription `src/api/routes/meetings.ts` and `src/services/meetings.ts`: read-only idempotency lookup. Test project isolation, hash checks, lookup misses, and zero enqueue side effects. |
| 2. State and policy | Add `calendar-autojoin-store.ts` and `google-calendar.ts`. Reuse shared KV lane/index. Test recurring moves/DST, sparse cancellation, attendance/link parsing, short ended events, pagination failure, tombstones after deletion, and same/different-account reconnect. |
| 3. Consent and credentials | Extend `google-oauth.ts` service/routes; add authenticated autojoin status/enable/disable routes and disconnect cleanup. Wire a Google credential-store instance in `backend/src/index.ts`. Extend `google-oauth.test.ts`: actual scopes, interrupted setup, refresh/disconnect races, invalid grant, tenant isolation, and unchanged ordinary browser-only connection. Derive every tenant from the authenticated session. |
| 4. Worker | Add `calendar-autojoin-worker.ts`; wire startup/shutdown and no-overlap deployment. Test every crash boundary: before intent, successful create with lost response, lost ID write, lost ownership acknowledgement, disable during POST, lookup miss followed by delayed commit, disable/re-enable before a delayed create resolves, account replacement with persistent lookup misses, stop retry, expired Google grant, rate-limit 403/429 and Retry-After, and restart beyond cutoff. Assert one upstream recording and no POST after eligibility ends. |
| 5. Existing UI and import | Update `ConnectorsCard`, `ConnectorDialog`, and `consentCopy.ts`. Extract `TranscriberSection`'s save effect into one app-shell `useTranscriberLibrarySync`; extend `transcriberApi.ts`/`transcriberSave.ts` metadata. Extend existing `transcriber.test.ts`, `gmeetSync.test.ts`, `useGmeetSessionSync.test.tsx`, and `transcriberSave.test.ts` for regressions, including SQL write success followed by transcript KV failure and reload, for both empty and nonempty transcripts; the retry must repair the import without duplicating it. |

The library hook runs on unlock/return and retries while the app stays open. It lists owned recordings, imports completed ones idempotently by `(source, sourceId)`, and isolates per-recording failures. An import is complete only when both its SQL row and transcript KV body exist; SQL source IDs alone are insufficient. Repair missing bodies after partial writes or reload, explicitly writing `[]` for a valid empty transcript; preserve existing transcript bodies. Mount it once; the Sources UI consumes its state. Preserve manual titles; autojoins use Calendar title/start. The existing seven-day chat delegation cannot perform these background writes, so this deliberately uses the user's unlocked storage session. Recordings remain recoverable through the service and ownership index until explicitly deleted; verify deployed retention does not expire them before return.

Run focused unit/integration tests plus relevant type/build checks when implementing. One test-account smoke should cover browser-closed joining, host admission, disable, and return-time import. Mocks establish our state transitions, not live Google authorization or bot acceptance.

## Configuration needed

Enable Calendar API in the existing Google project; register the added scopes and complete Google's verification where required. Reuse the OAuth client/redirect. External apps left in Testing normally receive seven-day refresh tokens for these permissions, so unattended production use needs the appropriate publishing status. [Token lifetime reference](https://developers.google.com/identity/protocols/oauth2#expiration).

Wire autojoin alongside the existing Google OAuth routes; require their OAuth configuration, the transcription URL/key, and a valid `CONNECTOR_CREDENTIAL_MASTER`. Verify backend KV prefix listing, durable storage, nonoverlapping deployment, and transcription `ENABLED_PLATFORMS` including `google_meet`. These are actual dependencies, not a new rollout or approval program.

**Source and verification.** Remote main was refreshed in both clean worktrees. Tinychat advanced from `7a32c0b` to `f67bf08417c8954fc0bab4379e99db13977f4d96` (onboarding copy only); transcription remains `2cdaabd43ab43cfd8cf714f0045d8f01415926d6`. Planning used current source and official Google documentation. Key reuse points: [credential store](https://github.com/TinyCloudLabs/tinychat/blob/f67bf08417c8954fc0bab4379e99db13977f4d96/backend/src/services/credential-store.ts#L24), [ownership index](https://github.com/TinyCloudLabs/tinychat/blob/f67bf08417c8954fc0bab4379e99db13977f4d96/backend/src/services/transcriber-index.ts#L10), and [library upsert](https://github.com/TinyCloudLabs/tinychat/blob/f67bf08417c8954fc0bab4379e99db13977f4d96/frontend/src/lib/transcriberSave.ts#L98). HTML structure and local source references were checked. Product code, production settings, live OAuth/Calendar/bot behavior, and product tests were not changed or exercised. The original dirty checkouts were preserved.
