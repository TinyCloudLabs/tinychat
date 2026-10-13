# @tinychat/backend

## 0.5.3-beta.1

### Patch Changes

- c34ce99: (TC-1047, TC-988) Calendar auto-join sends a meeting at its due time from a per-occurrence timer, instead of whenever the next worker tick (about 2 minutes on prod) reaches it; ticks remain the backstop. One occurrence's dispatch path (its reads, capture claims, the intent write and the post-send writes) runs at request lane priority. Each tick logs `code=tick_done` with its duration and tenant, row, scan and timer counts.

## 0.5.3-beta.0

### Patch Changes

- 1834edf: TC-1016: reuse notetaker send idempotency keys across retries and coalesce active or concurrent sends for the same meeting URL.

## 0.5.2

### Patch Changes

- 09d3bd1: TC-1006: meetings, Send notetaker and calendar auto-join actions no longer hang behind the auto-join worker on the shared backend storage lane. Request work now starts before queued worker work, and the worker still gets one slot after every 4 request jobs that overtake it. The worker's listings take one lane slot per row instead of holding the lane for the whole listing. Cached meetings-index reads skip the lane entirely. A request lane job that can't start within 12 s returns a retryable 503 instead of outwaiting the client. Lane waits of 1 s or more are now logged.

  Known limitation: the Connectors auto-join status read is bounded by one 12 s deadline for the whole read. For an account with more than about 6 auto-join rows (for example, many unaccepted invites in the last 30 days), it now answers 503 after about 12 s on every call instead of hanging. The same applies to the status returned after a successful enable or disable, whose change still lands. A capped or cached outcome listing is the follow-up.

## 0.5.2-beta.0

### Patch Changes

- 09d3bd1: TC-1006: meetings, Send notetaker and calendar auto-join actions no longer hang behind the auto-join worker on the shared backend storage lane. Request work now starts before queued worker work, and the worker still gets one slot after every 4 request jobs that overtake it. The worker's listings take one lane slot per row instead of holding the lane for the whole listing. Cached meetings-index reads skip the lane entirely. A request lane job that can't start within 12 s returns a retryable 503 instead of outwaiting the client. Lane waits of 1 s or more are now logged.

  Known limitation: the Connectors auto-join status read is bounded by one 12 s deadline for the whole read. For an account with more than about 6 auto-join rows (for example, many unaccepted invites in the last 30 days), it now answers 503 after about 12 s on every call instead of hanging. The same applies to the status returned after a successful enable or disable, whose change still lands. A capped or cached outcome listing is the follow-up.

## 0.5.1

### Patch Changes

- 244d7a6: Update TinyCloud web, node, core, and services SDKs to 3.2.0 and OpenKey SDK and Capacitor plugin to their stable releases, retaining the session-key patch for the TinyCloud node SDK.
- 37ef2fa: Treat the private transcriber's literal 'Unknown' speaker as unattributed (null) and keep it out of participants (TC-981).
- 2ac09a6: Widen Calendar autojoin's late-join window, preserve truthful RSVP outcomes without hiding dispatch failures, skip unchanged RSVP writes, and record discovery and dispatch lag (TC-988).
- 20faa03: Refresh saved transcriber transcripts when ptx publishes a newer version, keeping previous copies in an immutable archive and preserving edited meeting titles and start times (TC-989).
- 4a1e442: Require a configured HMAC secret and valid signature for PTX transcription webhooks.

## 0.5.1-beta.4

### Patch Changes

- 2ac09a6: Widen Calendar autojoin's late-join window, preserve truthful RSVP outcomes without hiding dispatch failures, skip unchanged RSVP writes, and record discovery and dispatch lag (TC-988).

## 0.5.1-beta.3

### Patch Changes

- 4a1e442: Require a configured HMAC secret and valid signature for PTX transcription webhooks.

## 0.5.1-beta.2

### Patch Changes

- 20faa03: Refresh saved transcriber transcripts when ptx publishes a newer version, keeping previous copies in an immutable archive and preserving edited meeting titles and start times (TC-989).

## 0.5.1-beta.1

### Patch Changes

- 244d7a6: Update TinyCloud web, node, core, and services SDKs to 3.2.0 and OpenKey SDK and Capacitor plugin to their stable releases, retaining the session-key patch for the TinyCloud node SDK.

## 0.5.1-beta.0

### Patch Changes

- 37ef2fa: Treat the private transcriber's literal 'Unknown' speaker as unattributed (null) and keep it out of participants (TC-981).

## 0.5.0

### Minor Changes

- d3071e8: Make Private transcription available to every signed-in account by removing the rollout flag and allowlist. Keep the route mounted when PTX is unconfigured so authenticated requests receive `service_misconfigured` and unauthenticated probes receive 401.
- 799d72f: Calendar auto-join sends one bot when two connected accounts auto-join the same Meet (TC-581). The second account sends no bot while the other bot is in the call, and sends its own if that bot leaves within its joining window. It sees a neutral "Already being recorded by another TinyCloud account" state instead of a failure. With `CALENDAR_AUTOJOIN_SHARING` off (the default), that state never promises a transcript. With it on, the second account gets the transcript only if both checks pass: the other account is on its own invite, and its verified Google email accepted the bot owner's own invite. If the other account is not on its own invite, the collision shows as unverified ("an account we couldn't match to your invite") and is never shared. Shared recordings show as "Shared recording" and can be removed from your list, but not ended or deleted. Auto-join now also asks for the `email` scope; existing connections must reconnect before they can be matched or receive a share.
- c65d24f: Add feature-gated server delivery of Private Transcription transcripts into a user's connector SQL and KV space using a verified, narrow session-key delegation. Preserve the browser importer as a ten-minute fallback and keep production rollout blocked on the node SQL-scope fix (TC-825).
- b6ffb9b: Native OpenKey sign-in for the Exo app (TC-775 E1). Inside the iOS/Android app only, sign-in runs the OpenKey delegation flow (PAR + PKCE in the system browser) and restores a TinyCloudWeb session whose key lives in the device secure store — the web and Tauri desktop keep the embedded widget. The backend's `/api/auth/nonce` now accepts a request without `address` and issues an unbound, single-use, 5-minute nonce that `/verify` binds to the recovered signer. Secrets-dependent surfaces (connector connect/sync/disconnect, queued sync, the background drains, own AssemblyAI key) are gated on native sessions, which have no vault capability; voice notes are unaffected.

### Patch Changes

- 9aa2dcc: Handle the private transcription service's 429 `capacity_exhausted` (TC-907). Calendar auto-join counts each create attempt once, so its backoff no longer doubles per attempt. An occurrence the service keeps refusing for capacity now ends after its joining window with the outcome "All TinyCloud notetakers were busy when this meeting started." Before, it was polled every 15 minutes indefinitely and never cleaned up. A manual send that hits the cap now shows the service's "All N meeting notetakers are busy…" message instead of the generic "temporarily unavailable" text, and the backend relays `Retry-After` and `retry_after_seconds` on any upstream 429.
- 3952464: Issue fresh SIWE-verified backend bearers for up to 30 days, capped by the signed SIWE expiration time. Existing bearers keep their original expiry.
- adbbaa4: Move to TinyCloud js-sdk 3.1.0 (from 2.11.0). Sessions and grants keep their 30-day lifetimes; existing web and desktop sessions are not re-signed.

## 0.5.0-beta.6

### Minor Changes

- d3071e8: Make Private transcription available to every signed-in account by removing the rollout flag and allowlist. Keep the route mounted when PTX is unconfigured so authenticated requests receive `service_misconfigured` and unauthenticated probes receive 401.

## 0.5.0-beta.5

### Minor Changes

- c65d24f: Add feature-gated server delivery of Private Transcription transcripts into a user's connector SQL and KV space using a verified, narrow session-key delegation. Preserve the browser importer as a ten-minute fallback and keep production rollout blocked on the node SQL-scope fix (TC-825).

## 0.5.0-beta.4

### Patch Changes

- 9aa2dcc: Handle the private transcription service's 429 `capacity_exhausted` (TC-907). Calendar auto-join counts each create attempt once, so its backoff no longer doubles per attempt. An occurrence the service keeps refusing for capacity now ends after its joining window with the outcome "All TinyCloud notetakers were busy when this meeting started." Before, it was polled every 15 minutes indefinitely and never cleaned up. A manual send that hits the cap now shows the service's "All N meeting notetakers are busy…" message instead of the generic "temporarily unavailable" text, and the backend relays `Retry-After` and `retry_after_seconds` on any upstream 429.

## 0.5.0-beta.3

### Minor Changes

- 799d72f: Calendar auto-join sends one bot when two connected accounts auto-join the same Meet (TC-581). The second account sends no bot while the other bot is in the call, and sends its own if that bot leaves within its joining window. It sees a neutral "Already being recorded by another TinyCloud account" state instead of a failure. With `CALENDAR_AUTOJOIN_SHARING` off (the default), that state never promises a transcript. With it on, the second account gets the transcript only if both checks pass: the other account is on its own invite, and its verified Google email accepted the bot owner's own invite. If the other account is not on its own invite, the collision shows as unverified ("an account we couldn't match to your invite") and is never shared. Shared recordings show as "Shared recording" and can be removed from your list, but not ended or deleted. Auto-join now also asks for the `email` scope; existing connections must reconnect before they can be matched or receive a share.

## 0.5.0-beta.2

### Patch Changes

- adbbaa4: Move to TinyCloud js-sdk 3.1.0 (from 2.11.0). Sessions and grants keep their 30-day lifetimes; existing web and desktop sessions are not re-signed.

## 0.5.0-beta.1

### Minor Changes

- b6ffb9b: Native OpenKey sign-in for the Exo app (TC-775 E1, behind `VITE_EXO_NATIVE_OPENKEY`). Inside the iOS/Android app only, sign-in runs the OpenKey delegation flow (PAR + PKCE in the system browser) and restores a TinyCloudWeb session whose key lives in the device secure store — the web and Tauri desktop keep the embedded widget. The backend's `/api/auth/nonce` now accepts a request without `address` and issues an unbound, single-use, 5-minute nonce that `/verify` binds to the recovered signer. Secrets-dependent surfaces (connector connect/sync/disconnect, queued sync, the background drains, own AssemblyAI key) are gated on native sessions, which have no vault capability; voice notes are unaffected. The flag stays off in every build until the OpenKey server side and the registered native client ship.

## 0.4.2-beta.0

### Patch Changes

- 3952464: Issue fresh SIWE-verified backend bearers for up to 30 days, capped by the signed SIWE expiration time. Existing bearers keep their original expiry.

## 0.4.1

### Patch Changes

- 532d811: Calendar autojoin status for an account that never connected Google now returns "off" without listing occurrences, so the read no longer exceeds the client's 20s timeout and shows an error.

## 0.4.1-beta.0

### Patch Changes

- 532d811: Calendar autojoin status for an account that never connected Google now returns "off" without listing occurrences, so the read no longer exceeds the client's 20s timeout and shows an error.

## 0.4.0

### Minor Changes

- 874ad74: Hosted AssemblyAI for Exo uploads: transcribe with TinyCloud's AssemblyAI key through the backend (capabilities, ≤1 MiB upload parts, signed transcript handles, per-account daily allowance)
- d1544c2: Private cloud transcription relay: accept MP4/M4A, WebM and FLAC uploads, pass speaker diarization through (`diarize` create option, `diarization` capability, diarized results with `speaker_<n>` voices), and follow more of the PTX batch API (cancelled and `processing_failed` job outcomes, null result language, `transcript_expired`, `upload_capability_limit`, and a replayed key of a deleted job).
- 874ad74: AssemblyAI delete proxy for Exo uploads

### Patch Changes

- 874ad74: Claim hosted AssemblyAI outcomes only when their handles are used, bound retained outcomes, and retry shutdown cleanup within a total deadline (TC-592).
- 874ad74: Delete unclaimed hosted AssemblyAI transcripts after 24 hours and retain bounded expiry tombstones. Resolve expired upload cleanup after reload and bound missing-outcome retries with persistent timestamps and a retention notice (TC-592).
- 874ad74: Keep hosted AssemblyAI submission outcomes visible while deleting temporary audio, retain unresolved Discard cleanup across reloads, and preserve Retry for recoverable hosted uploads without the original file.
- 874ad74: The app manifest grants the user's ASSEMBLYAI_API_KEY secret (read, write, delete) so Upload audio can keep an AssemblyAI key in the user's encrypted secrets.

## 0.4.0-beta.1

### Minor Changes

- 874ad74: Hosted AssemblyAI for Exo uploads: transcribe with TinyCloud's AssemblyAI key through the backend (capabilities, ≤1 MiB upload parts, signed transcript handles, per-account daily allowance)
- 874ad74: AssemblyAI delete proxy for Exo uploads

### Patch Changes

- 874ad74: Claim hosted AssemblyAI outcomes only when their handles are used, bound retained outcomes, and retry shutdown cleanup within a total deadline (TC-592).
- 874ad74: Delete unclaimed hosted AssemblyAI transcripts after 24 hours and retain bounded expiry tombstones. Resolve expired upload cleanup after reload and bound missing-outcome retries with persistent timestamps and a retention notice (TC-592).
- 874ad74: Keep hosted AssemblyAI submission outcomes visible while deleting temporary audio, retain unresolved Discard cleanup across reloads, and preserve Retry for recoverable hosted uploads without the original file.
- 874ad74: The app manifest grants the user's ASSEMBLYAI_API_KEY secret (read, write, delete) so Upload audio can keep an AssemblyAI key in the user's encrypted secrets.

## 0.4.0-beta.0

### Minor Changes

- d1544c2: Private cloud transcription relay: accept MP4/M4A, WebM and FLAC uploads, pass speaker diarization through (`diarize` create option, `diarization` capability, diarized results with `speaker_<n>` voices), and follow more of the PTX batch API (cancelled and `processing_failed` job outcomes, null result language, `transcript_expired`, `upload_capability_limit`, and a replayed key of a deleted job).

## 0.3.1

### Patch Changes

- 96007c1: Lost private agent access is no longer hidden. When an agent turn runs without private access (no session, an expired or stale grant, or a failed status check), the backend still answers from public tools, but first sends a `delegation_error` frame (`delegation_required`, `delegation_expired` or the new `delegation_unverified`). It also tells the model to send the user to Settings > Agent access to reconnect, not to pick another model. This applies to both the Eliza task path and the legacy loop. The browser shows the Reconnect banner without aborting the public answer, and a failed check reads "Couldn't verify" rather than "expired". The session status read before each turn now times out after 3s; POST and DELETE stay unbounded. Agent grants are minted for 29 days so a fast browser clock cannot trip the 30-day courier ceiling, and Connect errors name the server's code. The meeting tool contract accepts the `exo-local` source.

## 0.3.1-beta.0

### Patch Changes

- 96007c1: Lost private agent access is no longer hidden. When an agent turn runs without private access (no session, an expired or stale grant, or a failed status check), the backend still answers from public tools, but first sends a `delegation_error` frame (`delegation_required`, `delegation_expired` or the new `delegation_unverified`). It also tells the model to send the user to Settings > Agent access to reconnect, not to pick another model. This applies to both the Eliza task path and the legacy loop. The browser shows the Reconnect banner without aborting the public answer, and a failed check reads "Couldn't verify" rather than "expired". The session status read before each turn now times out after 3s; POST and DELETE stay unbounded. Agent grants are minted for 29 days so a fast browser clock cannot trip the 30-day courier ceiling, and Connect errors name the server's code. The meeting tool contract accepts the `exo-local` source.

## 0.3.0

### Minor Changes

- fcbdc49: The Google OAuth callback can return to the Exo mobile app. A flow the app starts carries a `native.` tag in its `state`, and for that tag only the callback redirects `{ code, state }` to the app's fixed deep link (`xyz.tinycloud.exo://oauth/google`) instead of posting it to the web origin. States with an unknown tag are refused. Web flows are unchanged, and the registered Google redirect URI stays the same. The native return is off unless `GOOGLE_OAUTH_NATIVE_RETURN=true`; while it is off, `native.` states are refused and the callback never redirects a code to the app.

### Patch Changes

- 69c76b3: Experimental Conversation Canvas, off by default. Settings → Experimental Features → Conversation Canvas adds a Chat/Canvas switch to each chat. Canvas visualizes branches, lets you continue from an earlier message, and pins versioned Markdown documents into the next request.
  - **Explicit opt-in per chat.** Each chat is switched to Canvas only after you confirm, with a warning about what changes.
  - **One chat history.** The chat history stays the single source every reader uses, including share links, other devices and older app versions. Picking a branch rewrites the chat to that branch, and messages sent elsewhere are folded into Canvas.
  - **Safe concurrent edits.** Edits from other tabs and devices are never overwritten.
  - **No cost when off.** Accounts and chats that never use Canvas never touch Canvas storage.
  - **Permission on enable.** Turning Canvas on asks for its storage permission when the session doesn't have it yet.
  - **Backend manifest.** The backend's app manifest adds the `canvas` SQL permission.

- f69c62a: Private cloud transcription relay: accept PTX batch's actual job and list shapes. PTX reports lifecycle timestamps instead of `updated_at` (the relay now derives `updated_at` from the latest one), reports `retention.audio: "not_received"` before the upload, and lists jobs as `{ object: "list", data }`. Before this, every status poll and list through the relay failed with `upstream_bad_response` against a real PTX. Jobs now also carry the caller's own `channel_mode` and `channel_labels`, which is how Exo desktop and Exo mobile tell their jobs apart on one account.

## 0.3.0-beta.2

### Patch Changes

- f69c62a: Private cloud transcription relay: accept PTX batch's actual job and list shapes. PTX reports lifecycle timestamps instead of `updated_at` (the relay now derives `updated_at` from the latest one), reports `retention.audio: "not_received"` before the upload, and lists jobs as `{ object: "list", data }`. Before this, every status poll and list through the relay failed with `upstream_bad_response` against a real PTX. Jobs now also carry the caller's own `channel_mode` and `channel_labels`, which is how Exo desktop and Exo mobile tell their jobs apart on one account.

## 0.3.0-beta.1

### Minor Changes

- fcbdc49: The Google OAuth callback can return to the Exo mobile app. A flow the app starts carries a `native.` tag in its `state`, and for that tag only the callback redirects `{ code, state }` to the app's fixed deep link (`xyz.tinycloud.exo://oauth/google`) instead of posting it to the web origin. States with an unknown tag are refused. Web flows are unchanged, and the registered Google redirect URI stays the same. The native return is off unless `GOOGLE_OAUTH_NATIVE_RETURN=true`; while it is off, `native.` states are refused and the callback never redirects a code to the app.

## 0.2.1-beta.0

### Patch Changes

- 69c76b3: Experimental Conversation Canvas, off by default. Settings → Experimental Features → Conversation Canvas adds a Chat/Canvas switch to each chat. Canvas visualizes branches, lets you continue from an earlier message, and pins versioned Markdown documents into the next request.
  - **Explicit opt-in per chat.** Each chat is switched to Canvas only after you confirm, with a warning about what changes.
  - **One chat history.** The chat history stays the single source every reader uses, including share links, other devices and older app versions. Picking a branch rewrites the chat to that branch, and messages sent elsewhere are folded into Canvas.
  - **Safe concurrent edits.** Edits from other tabs and devices are never overwritten.
  - **No cost when off.** Accounts and chats that never use Canvas never touch Canvas storage.
  - **Permission on enable.** Turning Canvas on asks for its storage permission when the session doesn't have it yet.
  - **Backend manifest.** The backend's app manifest adds the `canvas` SQL permission.

## 0.2.0

### Minor Changes

- 2eecb38: Private cloud transcription API for Exo desktop (`/api/transcriber/private-cloud`), dark by default: `PRIVATE_CLOUD_TRANSCRIPTION_ENABLED` plus an account allowlist gate the routes. The backend creates batch jobs on the private transcription service with an HMAC tenant reference instead of the wallet address, returns a relative upload path with a job-scoped capability (audio goes straight from the desktop to the service), and relays status, results, cancel and delete with stable error codes and correlation ids.

### Patch Changes

- e822748: Expose backendRevision and backendVersion in /api/server-info so deploys can prove the new build is live.
- 5c16fb5: Allow the Exo mobile app's fixed origins (`https://localhost` on Android, `capacitor://localhost` on iOS) in CORS.

## 0.2.0-beta.1

### Patch Changes

- 5c16fb5: Allow the Exo mobile app's fixed origins (`https://localhost` on Android, `capacitor://localhost` on iOS) in CORS.

## 0.2.0-beta.0

### Minor Changes

- 2eecb38: Private cloud transcription API for Exo desktop (`/api/transcriber/private-cloud`), dark by default: `PRIVATE_CLOUD_TRANSCRIPTION_ENABLED` plus an account allowlist gate the routes. The backend creates batch jobs on the private transcription service with an HMAC tenant reference instead of the wallet address, returns a relative upload path with a job-scoped capability (audio goes straight from the desktop to the service), and relays status, results, cancel and delete with stable error codes and correlation ids.

### Patch Changes

- e822748: Expose backendRevision and backendVersion in /api/server-info so deploys can prove the new build is live.
