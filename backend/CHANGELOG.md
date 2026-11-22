# @tinychat/backend

## 0.9.5-beta.1

### Patch Changes

- 49239bf: The agent session check waits up to 8 seconds for the MCP before it answers 502 mcp_unavailable, and logs the error code, the upstream HTTP status and the elapsed milliseconds when it fails, so the cause of that answer can be read in the logs.

  Details: TC-3739

## 0.9.5-beta.0

### Patch Changes

- fcdb738: The backend records each agent chat credit check as a structured event, so how many chats fall below the credit floor can be counted.

  Details: TC-3734

## 0.9.4

### Patch Changes

- 13e3e0c: The backend's own TinyCloud session names the keys it uses in its storage space. Its 30-day lifetime is set explicitly. Nothing changes for people using TinyChat.

  Details: TC-3443

## 0.9.4-beta.0

### Patch Changes

- 13e3e0c: The backend's own TinyCloud session names the keys it uses in its storage space. Its 30-day lifetime is set explicitly. Nothing changes for people using TinyChat.

  Details: TC-3443

## 0.9.3

### Patch Changes

- 6759764: The backend accepts requests from the phone apps at `https://app.tinycloud.one` (Android) and `tinycloudone://app.tinycloud.one` (iOS), as well as `https://localhost` and `capacitor://localhost`, which installed builds use.

  Details: TC-3693

- e52b520: The backend now states the storage access it needs in its own space when it signs in, so a later upgrade of the TinyCloud library cannot cut it off from its own data. It asks to read, write, delete and list there and for nothing else.

  Details: TC-3671

- 0cd1ccc: The billing error message names TinyCloud One.

  Details: TC-3659

- 69fba34: Background transcript delivery keeps a person's saved delivery permission through temporary errors. It removes the permission only when the TinyCloud node reports it as revoked; any other refusal is retried and logged.

  Details: TC-3076

## 0.9.3-beta.3

### Patch Changes

- 6759764: The backend accepts requests from the phone apps at `https://app.tinycloud.one` (Android) and `tinycloudone://app.tinycloud.one` (iOS), as well as `https://localhost` and `capacitor://localhost`, which installed builds use.

  Details: TC-3693

## 0.9.3-beta.2

### Patch Changes

- e52b520: The backend now states the storage access it needs in its own space when it signs in, so a later upgrade of the TinyCloud library cannot cut it off from its own data. It asks to read, write, delete and list there and for nothing else.

  Details: TC-3671

## 0.9.3-beta.1

### Patch Changes

- 0cd1ccc: The billing error message names TinyCloud One.

  Details: TC-3659

## 0.9.3-beta.0

### Patch Changes

- 69fba34: Background transcript delivery removes a user's stored delivery grant only when the TinyCloud node reports it revoked or expired. When activating the grant gets 401 or 403, it asks the node for the grant's status. For any other answer it keeps the grant, retries and logs the reason (never the delegation id).

  Details: TC-3076

## 0.9.2

### Patch Changes

- 49f8456: Powerful transcriptions that the provider can't take right away wait and finish by themselves. The server keeps the audio and retries (after 1, 2, 5 and 10 minutes, then every 10) for up to 24 hours, and never sends the same paid request twice when the outcome is unclear. While it waits, the note and the upload sheet show "Transcription delayed" and say it will finish automatically.

  Details: TC-2131

- 95b5f15: Main can read web pages and search the web. It's off until you turn it on: in Main's chat, tap Web access and choose a setting. You can limit it to sites you list.

  Details: TC-2808

- d519be5: Background memory extraction asks each model for its lowest reasoning setting, which keeps hidden reasoning tokens down on short turns; the turn's total includes the extraction once it settles.

  Details: TC-2002

## 0.9.2-beta.2

### Patch Changes

- 95b5f15: Main can read web pages and search the web. It's off until you turn it on: in Main's chat, tap Web access and choose a setting. You can limit it to sites you list.

  Details: TC-2808

## 0.9.2-beta.1

### Patch Changes

- d519be5: Background memory extraction asks each model for its lowest reasoning setting, which keeps hidden reasoning tokens down on short turns; the turn's total includes the extraction once it settles.

  Details: TC-2002

## 0.9.2-beta.0

### Patch Changes

- 49f8456: Powerful transcriptions that the provider can't take right away wait and finish by themselves. The server keeps the audio and retries (after 1, 2, 5 and 10 minutes, then every 10) for up to 24 hours, and never sends the same paid request twice when the outcome is unclear. While it waits, the note and the upload sheet show "Transcription delayed" and say it will finish automatically.

  Details: TC-2131

## 0.9.1

### Patch Changes

- 298c5b1: Import meetings from a Granola CSV export. Meetings you've deleted aren't imported again unless you allow them back.

  Details: TC-3292

- 298c5b1: Importing a Granola CSV leaves notes synced from Granola's API unchanged. A meeting you deleted stays out of later Granola syncs and CSV imports until you choose "Allow deleted meetings back" and confirm.

  Details: TC-3292

- 05459bb: Enable Granola imports and API sync in production.

  Details: TC-3292

- 4444996: Main gives earlier messages more time to load when it starts. It shows "Loading earlier messages…" while they load, and you can send a message in the meantime.
- 2e88e1e: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 2bcde9f: Trim oversized web search results instead of failing the reply (TC-3464). A `web_search` result over 64K characters is cut to 64K with the `[...truncated...]` marker and the model answers from it; reading stops at a 256K hard bound, past which the reply still ends with `result_size_limit` (ours, free). Meeting reads keep failing on overflow, since their structured evidence cannot be cut.

## 0.9.1-beta.4

### Patch Changes

- 05459bb: Enable Granola imports and API sync in production.

  Details: TC-3292

## 0.9.1-beta.3

### Patch Changes

- 2e88e1e: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

## 0.9.1-beta.2

### Patch Changes

- 4444996: Main gives earlier messages more time to load when it starts. It shows "Loading earlier messages…" while they load, and you can send a message in the meantime.

## 0.9.1-beta.1

### Patch Changes

- 2bcde9f: Trim oversized web search results instead of failing the reply (TC-3464). A `web_search` result over 64K characters is cut to 64K with the `[...truncated...]` marker and the model answers from it; reading stops at a 256K hard bound, past which the reply still ends with `result_size_limit` (ours, free). Meeting reads keep failing on overflow, since their structured evidence cannot be cut.

## 0.9.1-beta.0

### Patch Changes

- 298c5b1: Import meetings from a Granola CSV export. Meetings you've deleted aren't imported again unless you allow them back.

  Details: TC-3292

- 298c5b1: Importing a Granola CSV leaves notes synced from Granola's API unchanged. A meeting you deleted stays out of later Granola syncs and CSV imports until you choose "Allow deleted meetings back" and confirm.

  Details: TC-3292

## 0.9.0

### Minor Changes

- 8ec6a58: Web sign-in goes through OpenKey's own sign-in window. When that window offers automatic renewal and the owner leaves it on, the session renews for up to 90 days without another sign-in. Otherwise a sign-in lasts its usual 30 days.

  Details: TC-2872

### Patch Changes

- 74889d5: If you disconnect Fireflies and connect it again, Sync now imports your older meetings again.

  Details: TC-2778

- 74889d5: Internal changes for Fireflies sync; nothing in the app changes.

  Details: TC-2778

- 74889d5: Internal changes for Fireflies sync; nothing in the app changes. Details: TC-2778
- 74889d5: The Granola connection answers a slow, oversized or unreadable response from Granola with a clear error, and passes Retry-After along on rate limits and failures.

  Details: TC-3292

- 74889d5: Internal changes for Granola meeting sync; nothing in the app changes. Details: TC-3292
- 59e0b09: Import meetings from a Granola CSV export. Meetings you've deleted aren't imported again unless you allow them back.

  Details: TC-3292

- 7973a69: The secret guard reads a one-tap approval link the way a browser opens it.

  Details: TC-3242

- 7e1f3ee: Chat over the hosted MCP now shows the speaker names you set on a note. A rename (for example "Them" to "Sam") is stored on the note as `speaker_names`; the reader applies it to the transcript lines it gives the model, so answers, citations and speaker filters use the shown name. Names are cleaned the same way as in the app (one line, at most 80 characters). A name that is blank, not text, or part of an oversized map is ignored and the stored label is kept. If the names cannot be read, the stored labels are shown. Details: TC-2189
- 74889d5: Internal changes for deploys; nothing in the app changes.

  Details: TC-2196

- 74889d5: Internal changes for build checks; nothing in the app changes.

  Details: TC-2778

- d3f87c9: Google connections started on tinycloud.chat keep returning to tinycloud.chat after the backend's web app address (`FRONTEND_URL`) moves to https://tinycloud.one. A connection started without a site tag, which is how a visitor still working on tinycloud.chat starts one, now finishes on tinycloud.chat, as it already did when the address was home.tinycloud.xyz. Connections started on tinycloud.one or home.tinycloud.xyz still return to their own site. This release changes no settings. Set `FRONTEND_URL` to https://tinycloud.one only with this backend or after it.
- 74889d5: Internal changes for sign-in; nothing in the app changes.

  Details: TC-3030

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: When TinyCloud is already running as many bots as it can, a message to a bot now says so and that it wasn't sent, with a Try again button, instead of the general "couldn't start" line.

  Details: TC-3325

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: The backend can now hold more than one bot per account, each with its own permission to save its history. Every account still has one bot, Main, and it works as before.

  Details: TC-3325

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: Deleting a bot now finishes only after its cleanup is done.

  Details: TC-3360

- ad02ee7: Disconnect agent in Settings > Agent access ends the access of an agent connected through the TinyCloud connector, and shows Disconnected once the agent can no longer use it. An agent whose access you removed somewhere else shows as not connected. Settings > Agent access also explains what the access is for.

  Details: TC-2196

- 518be65: Stop a chat reply at the credit limit and never charge above it (TC-2601). Backend-orchestrated replies cap every provider call's `max_tokens` from the allowance the account had when the reply started and end with `budget_exhausted` instead of overshooting; all chat paths (agent chat, Eliza tasks, `/api/chat`) now settle through one clamp: a reply is charged at most its starting allowance and at most what is left of the window it started in, a failed reply is charged only when the model's own output broke it (a tool it was not offered, tool calls that never finished or did not parse, output over its cap) and is otherwise free even after content was delivered, and a timed-out reply is charged at most its starting allowance. The ledger record id is now the reply's execution id. Eliza `/tasks` monitor modes are unchanged. Customer-visible effect: replies near the limit can end early with the existing "reached the limit" notice, overshoot is platform cost, not the user's, and provider or server failures cost nothing. See `docs/credits.md`.
- 860953b: Record why a chat stream failed (TC-3462). A `tinychat_request` record whose stream ended in `error` now carries `failure_cause`: `model` when the model's own output broke the reply (the charged causes in `docs/credits.md`), otherwise `ours`. It is recorded from the stream terminal, so it is present with paywall gating off, and the log shipper allowlist passes only `model` or `ours`. No ledger change.
- f4a51c2: Recover when the model calls a tool the turn did not offer (TC-3463). On a public-only turn, a call to any tool but `web_search` (native or inline markup) now gets a `tool_not_found` tool result instead of failing the reply with `routing_mismatch`: nothing is dispatched, no tool activity is shown, and the model answers on its next round. A model that keeps calling unoffered tools until its rounds run out still fails with `routing_mismatch` (model-caused, charged).

## 0.9.0-beta.6

### Patch Changes

- ad02ee7: Disconnect agent in Settings > Agent access ends the access of an agent connected through the TinyCloud connector, and shows Disconnected once the agent can no longer use it. An agent whose access you removed somewhere else shows as not connected. Settings > Agent access also explains what the access is for.

  Details: TC-2196

## 0.9.0-beta.5

### Patch Changes

- f4a51c2: Recover when the model calls a tool the turn did not offer (TC-3463). On a public-only turn, a call to any tool but `web_search` (native or inline markup) now gets a `tool_not_found` tool result instead of failing the reply with `routing_mismatch`: nothing is dispatched, no tool activity is shown, and the model answers on its next round. A model that keeps calling unoffered tools until its rounds run out still fails with `routing_mismatch` (model-caused, charged).

## 0.9.0-beta.4

### Patch Changes

- 59e0b09: Import meetings from a Granola CSV export. Meetings you've deleted aren't imported again unless you allow them back.

  Details: TC-3292

## 0.9.0-beta.3

### Patch Changes

- 860953b: Record why a chat stream failed (TC-3462). A `tinychat_request` record whose stream ended in `error` now carries `failure_cause`: `model` when the model's own output broke the reply (the charged causes in `docs/credits.md`), otherwise `ours`. It is recorded from the stream terminal, so it is present with paywall gating off, and the log shipper allowlist passes only `model` or `ours`. No ledger change.

## 0.9.0-beta.2

### Patch Changes

- 7973a69: The secret guard reads a one-tap approval link the way a browser opens it.

  Details: TC-3242

- 751b563: Google connections started on tinycloud.chat keep returning to tinycloud.chat after the backend's web app address (`FRONTEND_URL`) moves to https://tinycloud.one. A connection started without a site tag, which is how a visitor still working on tinycloud.chat starts one, now finishes on tinycloud.chat, as it already did when the address was home.tinycloud.xyz. Connections started on tinycloud.one or home.tinycloud.xyz still return to their own site. This release changes no settings. Set `FRONTEND_URL` to https://tinycloud.one only with this backend or after it.
- 518be65: Stop a chat reply at the credit limit and never charge above it (TC-2601). Backend-orchestrated replies cap every provider call's `max_tokens` from the allowance the account had when the reply started and end with `budget_exhausted` instead of overshooting; all chat paths (agent chat, Eliza tasks, `/api/chat`) now settle through one clamp: a reply is charged at most its starting allowance and at most what is left of the window it started in, a failed reply is charged only when the model's own output broke it (a tool it was not offered, tool calls that never finished or did not parse, output over its cap) and is otherwise free even after content was delivered, and a timed-out reply is charged at most its starting allowance. The ledger record id is now the reply's execution id. Eliza `/tasks` monitor modes are unchanged. Customer-visible effect: replies near the limit can end early with the existing "reached the limit" notice, overshoot is platform cost, not the user's, and provider or server failures cost nothing. See `docs/credits.md`.

## 0.9.0-beta.1

### Patch Changes

- 74889d5: If you disconnect Fireflies and connect it again, Sync now imports your older meetings again.

  Details: TC-2778

- 74889d5: Internal changes for Fireflies sync; nothing in the app changes.

  Details: TC-2778

- 74889d5: Internal changes for Fireflies sync; nothing in the app changes. Details: TC-2778
- 74889d5: The Granola connection answers a slow, oversized or unreadable response from Granola with a clear error, and passes Retry-After along on rate limits and failures.

  Details: TC-3292

- 74889d5: Internal changes for Granola meeting sync; nothing in the app changes. Details: TC-3292
- 7e1f3ee: Chat over the hosted MCP now shows the speaker names you set on a note. A rename (for example "Them" to "Sam") is stored on the note as `speaker_names`; the reader applies it to the transcript lines it gives the model, so answers, citations and speaker filters use the shown name. Names are cleaned the same way as in the app (one line, at most 80 characters). A name that is blank, not text, or part of an oversized map is ignored and the stored label is kept. If the names cannot be read, the stored labels are shown. Details: TC-2189
- 74889d5: Internal changes for deploys; nothing in the app changes.

  Details: TC-2196

- 74889d5: Internal changes for build checks; nothing in the app changes.

  Details: TC-2778

- d3f87c9: Google connections started on tinycloud.chat keep returning to tinycloud.chat after the backend's web app address (`FRONTEND_URL`) moves to https://tinycloud.one. A connection started without a site tag, which is how a visitor still working on tinycloud.chat starts one, now finishes on tinycloud.chat, as it already did when the address was home.tinycloud.xyz. Connections started on tinycloud.one or home.tinycloud.xyz still return to their own site. This release changes no settings. Set `FRONTEND_URL` to https://tinycloud.one only with this backend or after it.
- 74889d5: Internal changes for sign-in; nothing in the app changes.

  Details: TC-3030

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: When TinyCloud is already running as many bots as it can, a message to a bot now says so and that it wasn't sent, with a Try again button, instead of the general "couldn't start" line.

  Details: TC-3325

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: The backend can now hold more than one bot per account, each with its own permission to save its history. Every account still has one bot, Main, and it works as before.

  Details: TC-3325

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: Deleting a bot now finishes only after its cleanup is done.

  Details: TC-3360

## 0.9.0-beta.0

### Minor Changes

- 8ec6a58: Web sign-in goes through OpenKey's own sign-in window. When that window offers automatic renewal and the owner leaves it on, the session renews for up to 90 days without another sign-in. Otherwise a sign-in lasts its usual 30 days.

  Details: TC-2872

## 0.8.0

### Minor Changes

- e31dd71: Ship one metadata record per request to the private log sink: request id, route template, method, status, duration, stream outcome and code, credits charged and a keyed account hash (new optional `REQUEST_LOG_HMAC_KEY`). Records are capped per minute and never carry bodies, headers, keys, emails or IPs. The local `tinychat_request` event's `route` now includes the mount template (for example `/api/chat` instead of `/`).
- abe8e22: Save bot chat history encrypted in the owner's TinyCloud space, with verified model receipts and storage acknowledgments. Notify the owner in Main's chat when expired TinyCloud permission schedules local history deletion, and resume copying after reconnection. Details: TC-2808.
- 033a30f: Tiny bots, slice 1 (TC-2808), off by default. For accounts on `BOTS_TEST_ACCOUNTS` with `BOTS_ENABLED=true`, Home shows a "What do you want done?" box that sends to Main, the owner's main bot, and opens Main's chat with the reply streaming in. The backend adds `/api/bots/status` and `/api/bots/main/messages`, which forward to the new bots service (`bots/`). Everyone else sees no change.

### Patch Changes

- 9bf796f: Record legacy agent-turn credit usage before ending either successful or failed responses so immediate follow-up chat requests enforce the updated budget. Preserve the existing soft-cap policy and streamed answer.
- be21a74: Google connections started on tinycloud.one return to tinycloud.one. The backend accepts two new `state` tags, `one.<nonce>` for the popup return and `onetab.<path>.<nonce>` for the same-tab return; both go to the fixed https://tinycloud.one origin when it is in the `FRONTEND_ORIGINS` allowlist (it is by default), and are refused like any unknown tag when it is not. Untagged, `tab.`, `home.`, `hometab.` and `native.` flows are unchanged.
- aa036e0: The backend accepts https://tinycloud.one, the Home app's new site, for CORS and the sign-in (SIWE) domain, alongside tinycloud.chat and home.tinycloud.xyz. It is one more exact origin in the default `FRONTEND_ORIGINS` list; `www.tinycloud.one`, other ports, other schemes and lookalike hosts are still refused. Google connections started on tinycloud.one still return to `FRONTEND_URL` until they get their own return tag.
- 20598f6: The backend accepts both tinycloud.chat and home.tinycloud.xyz for CORS, sign-in (the SIWE domain) and Google OAuth returns, through the new `FRONTEND_ORIGINS` allowlist: comma-separated exact origins, `FRONTEND_URL` always added, defaulting to `https://tinycloud.chat,https://home.tinycloud.xyz`. A Google connection started on tinycloud.chat returns to tinycloud.chat even after `FRONTEND_URL` moves to home.tinycloud.xyz; one started on home.tinycloud.xyz returns there. Stripe and connector-off links still use `FRONTEND_URL`.

  Deploy this backend before setting `TINYCHAT_FRONTEND_URL` to `https://home.tinycloud.xyz`. That variable is also the backend's `FRONTEND_URL`, and an older backend would stop accepting tinycloud.chat, where visitors whose recordings are still only in that browser stay.

- 339a1d2: Route Fireflies ingestion by the user's connection: server OAuth plus cohort eligibility selects backend ingestion; users without server OAuth keep browser access to their queued meetings.
- 915a8f9: Stop webhook admission on Fireflies disconnect, close the in-flight enqueue race, and retain purge-ledger ID timestamps without extending them on retries.
- 20484c4: Delete server-held Fireflies meeting IDs within 14 days and enforce authenticated content expiry and bounded replay protection.
- fc73a24: Remove reconciled server copies when Fireflies sync is disabled, preserving unreadable or unreconciled copies for retention cleanup.
- e667585: TinyCloud Home and the backend treat `https://node.tinycloud.xyz` and `https://tee.node.tinycloud.xyz` as the same TinyCloud node. Stored backend grants, bot history receipts, native delegations and agent CLI profiles on either name keep working when the default node name changes. The reviewer seed and the TinyChat retrieval skill (now 0.1.1-onboarding.26) default to `https://node.tinycloud.xyz`. Production still runs on `https://tee.node.tinycloud.xyz`; nothing changes for users.

  Details: TC-2923

- 17f9687: TC-3166: "Delete my recordings first" (the bulk `DELETE /api/transcriber/meetings`) now also deletes the account's private cloud transcription jobs, so voice notes and uploads left behind by a failed or cancelled run are cleared on account deletion. Queued or running jobs are cancelled, transcripts are deleted, and the call only succeeds once TinyCloud Private Transcription's own list for the account is empty; otherwise it is a 503 and safe to retry. The response gains `privateCloudDeleted` (a count, or `null` when private cloud transcription is not used), which the step requires, so an older backend can never produce a "deleted" claim for voice notes and uploads; with `null` the step says nothing about them. The bulk delete is also mounted when private cloud transcription is on and the meeting transcriber is off. A new `GET /api/transcriber/meetings/scope` (config only) tells the step whether the deployment keeps private cloud jobs, so its intro and failure line name voice notes and uploads only where they are kept; the step waits for it before showing anything.
- 7b5db01: TC-3136: removing a notetaker recording now deletes the capture provider's copy (audio, video, transcript and derived artifacts) and only counts it as gone after reading it back not-found. A delete that cannot be confirmed yet stays listed as "deleting" and is retried with backoff, never dropped. Settings → Account gains "Delete my recordings first", a bulk `DELETE /api/transcriber/meetings`, ahead of deleting the OpenKey account. A recording shared with you is only removed from your list. A recording the notetaker service cannot attribute to you is removed from your list but not deleted there, and says so on its row.
- ae08fc0: Streamed replies from confidential models now show an "Enclave verified" mark once the gateway's signed receipt checks out, or a note if it can't be confirmed. Details: TC-2196
- f4853a8: Add an explicit exact-email transcript share action to note detail, with read-only immutable encrypted snapshots, SDK-valid note-title filenames capped at 128 UTF-8 bytes with a nonempty fallback, and no audio inclusion.

  Adopt the published TinyCloud Web, Node, Core and Services SDKs at 3.11.0 (Share SDK 1.4.4 and Share Envelope 1.5.0, as pinned by those releases) for exact Share-key runtime consent, and remove the obsolete local NodeSDK sign-in patch now included upstream.

  Keep transcript-share dialogs open through same-owner, same-session runtime-grant refreshes. Reject stale account/content completions and surface interrupted shares without exposing the prior recipient or link. Treat an OpenKey cancellation of exact-key consent as a cancelled share.

  Discard underlying SDK errors at the transcript-share boundary so diagnostic cause chains contain only the sanitized failure message.

  Freeze speaker aliases in the shared copy using the transcript's existing display, Copy and export mapping. Reject semantic alias changes during sharing, including unused labels, and validate the same projection against persisted metadata without rewriting stored sentences.

  Details: TC-2192

- 898ce96: Require a pinned content-master commitment and successful existing-index decrypt before canary enrollment; verify the encrypted canary before ingestion starts. Add an authenticated read-only continuity diagnostic. Existing ingestion deployments must pin CONNECTOR_CONTENT_EXPECTED_SHA256 from their live master before first startup; fresh installations require explicit CONNECTOR_CONTENT_ENROLL_FRESH=true enrollment.

  Take the ingest singleton lease before enrollment and reject blank pins. Require encoded random key material for new enrollment. An unset master permits startup only with empty sealed storage, leaves sealed features disabled, and returns a diagnostic error without a fingerprint.

  Close connections that become idle after an in-flight response finishes during shutdown, so Bun shutdown does not wait for keep-alive expiry. Tighten base64 padding validation and limit the diagnostic exemption to its literal path.

- a4ab606: Adopt the published SDK graph and support browser restore with explicit owner-signed renewal leases. Details: TC-2872
- c709e31: TC-2917: calendar autojoin row writes are If-Match compare-and-sets on the node, a token refresh writes custody only if no other change happened since it was read, and the cached access-token map is bounded and evicted on expiry, disable or a new generation.
- c709e31: TC-2917: calendar autojoin reads consent from the node before every Google scan and recording check, and every connection write re-reads the stored row first, so a disable or deletion stored outside the backend is kept. The row cache is bounded, and a cached access token is dropped when any credential store in the process changes that credential.

  Every calendar row and credential write or delete is now conditional on the version it was decided on (If-Match / If-None-Match; a row the node sends without an ETag is refused, never written blind), and each row carries a revision so the node's content-hash ETag changes on every write. Enable and OAuth setup re-decide on the stored row. A token refresh is bound to the grant it read and re-reads custody after writing; cached access tokens serve at most 5 minutes after their custody read, and a status read showing a disable evicts them. markUsed is conditional and never recreates a deleted credential.

- 095dda1: TC-2917: the calendar autojoin worker reads connection and meeting rows from an in-process copy instead of the node every 30 s tick. Idle users, disabled connections and finished meetings no longer cost node calls; scheduling, due-time timers and dispatch policy reads are unchanged.
- 6d52413: The per-request log record now names its route only from the fixed list of routes the backend serves (anything else is `unmatched`), reports credits as a range (`0`, `1-9`, `10-99`, `100-999`, `1000+`) instead of an exact count, and uses an account pseudonym that changes every calendar month (UTC), so one account's records can be linked within a month but not across months. Details: TC-3031.
- 78c73f1: Support a bots service connection host with TLS verification against the service URL identity. Details: TC-2808
- 36f006a: Backend deploys pass the tiny bots settings (BOTS_ENABLED, BOTS_TEST_ACCOUNTS, BOTS_SERVICE_URL, BOTS_SERVICE_SECRET, BOTS_POST_TIMEOUT_MS) to the backend CVM; BOTS_ENABLED defaults to false. A new workflow, deploy-bots-phala.yml, deploys the bots service to its own CVM. Details: TC-2808
- f8823ef: Exo is now TinyCloud Home everywhere you can see it: the web app's title, install name and sign-in, the desktop app (now `TinyCloud Home.app`), the Android and iOS app names, notifications, permission prompts and error messages. Home opens on Feed on the web, on desktop and on iOS and Android, on a fresh install and after signing in, unless you chose Apps as your first screen in Settings. Feed and Apps are no longer experimental: they are in the navigation for everyone, and Settings › Home holds the first-screen choice. App id, bundle ids, URL schemes and every data path are unchanged. Details: TC-2050, TC-2040
- 98e2480: TinyCloud Home is now TinyCloud One everywhere you can see it: the web app's title, install name and sign-in, the desktop app (now `TinyCloud One.app`; `exo-update` replaces an existing `TinyCloud Home.app`), the Android and iOS app names, widgets, Siri phrases ("Start recording in TinyCloud One"), notifications, permission prompts and error messages. The main screen is now called Feed, and Settings › Start screen holds the first-screen choice. You stay signed in: the app id, bundle ids, URL schemes, installed web app id and every data path are unchanged, and nobody has to sign in again.
- 0d8fa35: Distinguish slow storage-lane waits from queue timeouts in private logs and include closed calendar failure classifications without account IDs, storage keys, values or error text. Preserve request-log rate limits and existing storage scheduling.

  Bound every non-request log stream to ten samples per minute and retain pre-sampling outcome counts in one fixed-size summary per minute, without changing the existing request-record limits.

- 761a6ba: The web build includes connector secret permissions and the decrypt permission at sign-in for devices that have used Connectors. First use requests access through OpenKey in place. Remove the unused custom AssemblyAI key permission from the manifest.

## 0.8.0-beta.26

### Patch Changes

- 17f9687: TC-3166: "Delete my recordings first" (the bulk `DELETE /api/transcriber/meetings`) now also deletes the account's private cloud transcription jobs, so voice notes and uploads left behind by a failed or cancelled run are cleared on account deletion. Queued or running jobs are cancelled, transcripts are deleted, and the call only succeeds once TinyCloud Private Transcription's own list for the account is empty; otherwise it is a 503 and safe to retry. The response gains `privateCloudDeleted` (a count, or `null` when private cloud transcription is not used), which the step requires, so an older backend can never produce a "deleted" claim for voice notes and uploads; with `null` the step says nothing about them. The bulk delete is also mounted when private cloud transcription is on and the meeting transcriber is off. A new `GET /api/transcriber/meetings/scope` (config only) tells the step whether the deployment keeps private cloud jobs, so its intro and failure line name voice notes and uploads only where they are kept; the step waits for it before showing anything.

## 0.8.0-beta.25

### Patch Changes

- 7b5db01: TC-3136: removing a notetaker recording now deletes the capture provider's copy (audio, video, transcript and derived artifacts) and only counts it as gone after reading it back not-found. A delete that cannot be confirmed yet stays listed as "deleting" and is retried with backoff, never dropped. Settings → Account gains "Delete my recordings first", a bulk `DELETE /api/transcriber/meetings`, ahead of deleting the OpenKey account. A recording shared with you is only removed from your list. A recording the notetaker service cannot attribute to you is removed from your list but not deleted there, and says so on its row.

## 0.8.0-beta.24

### Patch Changes

- c709e31: TC-2917: calendar autojoin row writes are If-Match compare-and-sets on the node, a token refresh writes custody only if no other change happened since it was read, and the cached access-token map is bounded and evicted on expiry, disable or a new generation.
- c709e31: TC-2917: calendar autojoin reads consent from the node before every Google scan and recording check, and every connection write re-reads the stored row first, so a disable or deletion stored outside the backend is kept. The row cache is bounded, and a cached access token is dropped when any credential store in the process changes that credential.

  Every calendar row and credential write or delete is now conditional on the version it was decided on (If-Match / If-None-Match; a row the node sends without an ETag is refused, never written blind), and each row carries a revision so the node's content-hash ETag changes on every write. Enable and OAuth setup re-decide on the stored row. A token refresh is bound to the grant it read and re-reads custody after writing; cached access tokens serve at most 5 minutes after their custody read, and a status read showing a disable evicts them. markUsed is conditional and never recreates a deleted credential.

## 0.8.0-beta.23

### Patch Changes

- 6d52413: The per-request log record now names its route only from the fixed list of routes the backend serves (anything else is `unmatched`), reports credits as a range (`0`, `1-9`, `10-99`, `100-999`, `1000+`) instead of an exact count, and uses an account pseudonym that changes every calendar month (UTC), so one account's records can be linked within a month but not across months. Details: TC-3031.

## 0.8.0-beta.22

### Patch Changes

- 98e2480: TinyCloud Home is now TinyCloud One everywhere you can see it: the web app's title, install name and sign-in, the desktop app (now `TinyCloud One.app`; `exo-update` replaces an existing `TinyCloud Home.app`), the Android and iOS app names, widgets, Siri phrases ("Start recording in TinyCloud One"), notifications, permission prompts and error messages. The main screen is now called Feed, and Settings › Start screen holds the first-screen choice. You stay signed in: the app id, bundle ids, URL schemes, installed web app id and every data path are unchanged, and nobody has to sign in again.

## 0.8.0-beta.21

### Patch Changes

- a4ab606: Adopt the published SDK graph and support browser restore with explicit owner-signed renewal leases. Details: TC-2872

## 0.8.0-beta.20

### Patch Changes

- be21a74: Google connections started on tinycloud.one return to tinycloud.one. The backend accepts two new `state` tags, `one.<nonce>` for the popup return and `onetab.<path>.<nonce>` for the same-tab return; both go to the fixed https://tinycloud.one origin when it is in the `FRONTEND_ORIGINS` allowlist (it is by default), and are refused like any unknown tag when it is not. Untagged, `tab.`, `home.`, `hometab.` and `native.` flows are unchanged.

## 0.8.0-beta.19

### Patch Changes

- aa036e0: The backend accepts https://tinycloud.one, the Home app's new site, for CORS and the sign-in (SIWE) domain, alongside tinycloud.chat and home.tinycloud.xyz. It is one more exact origin in the default `FRONTEND_ORIGINS` list; `www.tinycloud.one`, other ports, other schemes and lookalike hosts are still refused. Google connections started on tinycloud.one still return to `FRONTEND_URL` until they get their own return tag.

## 0.8.0-beta.18

### Patch Changes

- e667585: TinyCloud Home and the backend treat `https://node.tinycloud.xyz` and `https://tee.node.tinycloud.xyz` as the same TinyCloud node. Stored backend grants, bot history receipts, native delegations and agent CLI profiles on either name keep working when the default node name changes. The reviewer seed and the TinyChat retrieval skill (now 0.1.1-onboarding.26) default to `https://node.tinycloud.xyz`. Production still runs on `https://tee.node.tinycloud.xyz`; nothing changes for users.

  Details: TC-2923

## 0.8.0-beta.17

### Patch Changes

- 095dda1: TC-2917: the calendar autojoin worker reads connection and meeting rows from an in-process copy instead of the node every 30 s tick. Idle users, disabled connections and finished meetings no longer cost node calls; scheduling, due-time timers and dispatch policy reads are unchanged.

## 0.8.0-beta.16

### Patch Changes

- 339a1d2: Route Fireflies ingestion by the user's connection: server OAuth plus cohort eligibility selects backend ingestion; users without server OAuth keep browser access to their queued meetings.

## 0.8.0-beta.15

### Patch Changes

- 915a8f9: Stop webhook admission on Fireflies disconnect, close the in-flight enqueue race, and retain purge-ledger ID timestamps without extending them on retries.

## 0.8.0-beta.14

### Patch Changes

- fc73a24: Remove reconciled server copies when Fireflies sync is disabled, preserving unreadable or unreconciled copies for retention cleanup.

## 0.8.0-beta.13

### Patch Changes

- 20484c4: Delete server-held Fireflies meeting IDs within 14 days and enforce authenticated content expiry and bounded replay protection.

## 0.8.0-beta.12

### Minor Changes

- abe8e22: Save bot chat history encrypted in the owner's TinyCloud space, with verified model receipts and storage acknowledgments. Notify the owner in Main's chat when expired TinyCloud permission schedules local history deletion, and resume copying after reconnection. Details: TC-2808.

## 0.8.0-beta.11

### Patch Changes

- 78c73f1: Support a bots service connection host with TLS verification against the service URL identity. Details: TC-2808

## 0.8.0-beta.10

### Patch Changes

- 898ce96: Require a pinned content-master commitment and successful existing-index decrypt before canary enrollment; verify the encrypted canary before ingestion starts. Add an authenticated read-only continuity diagnostic. Existing ingestion deployments must pin CONNECTOR_CONTENT_EXPECTED_SHA256 from their live master before first startup; fresh installations require explicit CONNECTOR_CONTENT_ENROLL_FRESH=true enrollment.

  Take the ingest singleton lease before enrollment and reject blank pins. Require encoded random key material for new enrollment. An unset master permits startup only with empty sealed storage, leaves sealed features disabled, and returns a diagnostic error without a fingerprint.

  Close connections that become idle after an in-flight response finishes during shutdown, so Bun shutdown does not wait for keep-alive expiry. Tighten base64 padding validation and limit the diagnostic exemption to its literal path.

## 0.8.0-beta.9

### Patch Changes

- 20598f6: The backend accepts both tinycloud.chat and home.tinycloud.xyz for CORS, sign-in (the SIWE domain) and Google OAuth returns, through the new `FRONTEND_ORIGINS` allowlist: comma-separated exact origins, `FRONTEND_URL` always added, defaulting to `https://tinycloud.chat,https://home.tinycloud.xyz`. A Google connection started on tinycloud.chat returns to tinycloud.chat even after `FRONTEND_URL` moves to home.tinycloud.xyz; one started on home.tinycloud.xyz returns there. Stripe and connector-off links still use `FRONTEND_URL`.

  Deploy this backend before setting `TINYCHAT_FRONTEND_URL` to `https://home.tinycloud.xyz`. That variable is also the backend's `FRONTEND_URL`, and an older backend would stop accepting tinycloud.chat, where visitors whose recordings are still only in that browser stay.

## 0.8.0-beta.8

### Patch Changes

- f4853a8: Add an explicit exact-email transcript share action to note detail, with read-only immutable encrypted snapshots, SDK-valid note-title filenames capped at 128 UTF-8 bytes with a nonempty fallback, and no audio inclusion.

  Adopt the published TinyCloud Web, Node, Core and Services SDKs at 3.11.0 (Share SDK 1.4.4 and Share Envelope 1.5.0, as pinned by those releases) for exact Share-key runtime consent, and remove the obsolete local NodeSDK sign-in patch now included upstream.

  Keep transcript-share dialogs open through same-owner, same-session runtime-grant refreshes. Reject stale account/content completions and surface interrupted shares without exposing the prior recipient or link. Treat an OpenKey cancellation of exact-key consent as a cancelled share.

  Discard underlying SDK errors at the transcript-share boundary so diagnostic cause chains contain only the sanitized failure message.

  Freeze speaker aliases in the shared copy using the transcript's existing display, Copy and export mapping. Reject semantic alias changes during sharing, including unused labels, and validate the same projection against persisted metadata without rewriting stored sentences.

  Details: TC-2192

## 0.8.0-beta.7

### Patch Changes

- 36f006a: Backend deploys pass the tiny bots settings (BOTS_ENABLED, BOTS_TEST_ACCOUNTS, BOTS_SERVICE_URL, BOTS_SERVICE_SECRET, BOTS_POST_TIMEOUT_MS) to the backend CVM; BOTS_ENABLED defaults to false. A new workflow, deploy-bots-phala.yml, deploys the bots service to its own CVM. Details: TC-2808

## 0.8.0-beta.6

### Minor Changes

- 033a30f: Tiny bots, slice 1 (TC-2808), off by default. For accounts on `BOTS_TEST_ACCOUNTS` with `BOTS_ENABLED=true`, Home shows a "What do you want done?" box that sends to Main, the owner's main bot, and opens Main's chat with the reply streaming in. The backend adds `/api/bots/status` and `/api/bots/main/messages`, which forward to the new bots service (`bots/`). Everyone else sees no change.

## 0.8.0-beta.5

### Patch Changes

- ae08fc0: Streamed replies from confidential models now show an "Enclave verified" mark once the gateway's signed receipt checks out, or a note if it can't be confirmed. Details: TC-2196

## 0.8.0-beta.4

### Patch Changes

- 761a6ba: The web build includes connector secret permissions and the decrypt permission at sign-in for devices that have used Connectors. First use requests access through OpenKey in place. Remove the unused custom AssemblyAI key permission from the manifest.

## 0.8.0-beta.3

### Patch Changes

- f8823ef: Exo is now TinyCloud Home everywhere you can see it: the web app's title, install name and sign-in, the desktop app (now `TinyCloud Home.app`), the Android and iOS app names, notifications, permission prompts and error messages. Home opens on Feed on the web, on desktop and on iOS and Android, on a fresh install and after signing in, unless you chose Apps as your first screen in Settings. Feed and Apps are no longer experimental: they are in the navigation for everyone, and Settings › Home holds the first-screen choice. App id, bundle ids, URL schemes and every data path are unchanged. Details: TC-2050, TC-2040

## 0.8.0-beta.2

### Patch Changes

- 0d8fa35: Distinguish slow storage-lane waits from queue timeouts in private logs and include closed calendar failure classifications without account IDs, storage keys, values or error text. Preserve request-log rate limits and existing storage scheduling.

  Bound every non-request log stream to ten samples per minute and retain pre-sampling outcome counts in one fixed-size summary per minute, without changing the existing request-record limits.

## 0.8.0-beta.1

### Minor Changes

- e31dd71: Ship one metadata record per request to the private log sink: request id, route template, method, status, duration, stream outcome and code, credits charged and a keyed account hash (new optional `REQUEST_LOG_HMAC_KEY`). Records are capped per minute and never carry bodies, headers, keys, emails or IPs. The local `tinychat_request` event's `route` now includes the mount template (for example `/api/chat` instead of `/`).

## 0.7.1-beta.0

### Patch Changes

- 9bf796f: Record legacy agent-turn credit usage before ending either successful or failed responses so immediate follow-up chat requests enforce the updated budget. Preserve the existing soft-cap policy and streamed answer.

## 0.7.0

### Minor Changes

- a51b231: Adds https://home.tinycloud.xyz to the allowed web origins: CORS, the SIWE sign-in domain (signed like the production web domain), and the Google OAuth return. The OAuth `state` accepts two new tags, `home.<nonce>` for the popup return and `hometab.<path>.<nonce>` for the same-tab return; both go to the fixed Home origin. Untagged, `tab.` and `native.` flows are unchanged. Details: TC-2387

### Patch Changes

- 5d559f2: The validated meeting answer pipeline (interpretation, evidence ledger, draft validation, one repair, evidence fallback, coverage) now runs for accounts served by MCP chat when the meeting content rollout flags admit them; its reader compatibility check no longer calls eliza-service. For MCP turns only, `MEETING_CONTENT_TEST_ACCOUNTS` accepts `*` and an empty `MEETING_CONTENT_MODELS` admits every offered model. Claim citations in the validated render now carry the speaker and time, `[M1:E3, Speaker, hh:mm:ss]`, as tool results already do. An MCP turn refuses a tool name the MCP wrapper does not serve instead of forwarding it to eliza-service. Default behaviour is unchanged. Details: TC-2196

## 0.7.0-beta.1

### Minor Changes

- a51b231: Adds https://home.tinycloud.xyz to the allowed web origins: CORS, the SIWE sign-in domain (signed like the production web domain), and the Google OAuth return. The OAuth `state` accepts two new tags, `home.<nonce>` for the popup return and `hometab.<path>.<nonce>` for the same-tab return; both go to the fixed Home origin. Untagged, `tab.` and `native.` flows are unchanged. Details: TC-2387

## 0.6.1-beta.0

### Patch Changes

- 5d559f2: The validated meeting answer pipeline (interpretation, evidence ledger, draft validation, one repair, evidence fallback, coverage) now runs for accounts served by MCP chat when the meeting content rollout flags admit them; its reader compatibility check no longer calls eliza-service. For MCP turns only, `MEETING_CONTENT_TEST_ACCOUNTS` accepts `*` and an empty `MEETING_CONTENT_MODELS` admits every offered model. Claim citations in the validated render now carry the speaker and time, `[M1:E3, Speaker, hh:mm:ss]`, as tool results already do. An MCP turn refuses a tool name the MCP wrapper does not serve instead of forwarding it to eliza-service. Default behaviour is unchanged. Details: TC-2196

## 0.6.0

### Minor Changes

- 1714a70: Chat can read meetings through the hosted TinyCloud MCP for accounts listed in MCP_CHAT_TEST_ACCOUNTS (read-only, behind MCP_CHAT_ENABLED). Details: TC-2196

## 0.6.0-beta.0

### Minor Changes

- 1714a70: Chat can read meetings through the hosted TinyCloud MCP for accounts listed in MCP_CHAT_TEST_ACCOUNTS (read-only, behind MCP_CHAT_ENABLED). Details: TC-2196

## 0.5.7

### Patch Changes

- 1c140c0: Calendar autojoin now asks Google for Calendar events, openid and email only, and no longer asks for the Meet, Drive and Docs scopes or for previously granted scopes. Enabling it no longer saves a Google Meet token or runs a Meet sync; Google Meet stays a separate connect. Existing autojoin connections are not changed until the user reconnects.
- 3ac6081: The production backend CVM now runs a private log shipper sidecar. It sends startup lines (including `[startup] FATAL` and crash lines), hosted-AssemblyAI events and alerts to a private Better Stack source as typed fields only. It is inert until its source token is set, never gates the backend, and changes nothing for users.
- 813e839: Add an optional authenticated count of stored connector credentials, off unless a key is configured.
- 648edff: Add an optional one-time row count for stored connector credentials, off by default.
- 73b3241: Activate exactly scoped Exo sync grants: KV get, list, and del on the `requests/` prefix, and get, put, and del on the `jobs/` prefix. A flag-gated grant route, `GET|POST|DELETE /api/exo/v1/grant`, mounts only when `EXO_CAPABILITIES_ENABLED` is exactly `true`. A typed accessor refuses traversal, encoded, sibling, and lookalike paths, keys over 512 characters, stored values over 4 KiB, and invalid UTF-8 or byte-order-marked values before any KV call. Exo and connector grant records are bound to their own kind and key prefix, and connector records written before this change still load. `EXO_CAPABILITIES_ENABLED` stays off by default.
- 87993a3: With `EXO_CAPABILITIES_ENABLED` set to `true`, the Exo mailbox now runs on real stores. Cooldown, daily-count, and active-run state is kept in the backend KV with compare-and-set writes. Queued wakes drain on shutdown, expired job mirrors are swept hourly, and owner and source Exo state is cleared on grant revoke, transcript delegation revoke, calendar autojoin disconnect, and connector teardown. The flag remains off by default.
- eb888dd: Add a backend mailbox for Exo sync requests behind `EXO_CAPABILITIES_ENABLED`, which is off by default. The grant verifier now also accepts one exactly scoped Exo grant shape; connector grants are unchanged.
- 84819aa: Home signs in with the permissions in its manifest, including the requested secret decrypt grant.

  Details: TC-2038

- 8b3b819: Hosted transcription refusals are now classified (rejected key, insufficient balance, rate limit) and reported to operators: one alert when AssemblyAI starts refusing, one when it recovers, one after three failed jobs in a row, a heartbeat every minute, and a read-only status for the monitoring probe. Nothing changes for users yet.
- 0cd762b: Send a notetaker accepts every Google Meet link shape: `/meet/<code>`, `/_meet/<code>`, `g.co/meet/<code>`, `tel.meet/<code>`, links wrapped in `accounts.google.com?continue=` or `meet.app.goo.gl?link=`, and a bare code with or without dashes. All become `https://meet.google.com/<code>` (lowercase, no trailing slash). A wrapper whose target is not a Meet link is refused. `meet.google.com/lookup/<nick>` is sent as pasted.
- 57fb986: Send a notetaker accepts meeting links as people paste them. A link without `https://`, Google's `google.com/meet/<code>` form, a bare Meet code, a Gmail/Calendar or Outlook redirect, or a whole "Join with Google Meet" line now becomes the canonical meeting link before it goes to ptx. These used to fail with "That doesn't look like a meeting link" or "That meeting platform isn't supported yet". Any other link still goes upstream exactly as pasted, so capability links keep their query and fragment. The backend applies the same reading, so links from older clients work too.
- 333a8f1: Show the notetaker stuck-joining state.
- 0f22d69: Update the TinyCloud SDK packages to 3.8.0-beta.9 (replica 0.4.0-beta.3). The local copy now syncs entry names only and fetches a value when something reads it (`replication.contentFetch: "lazy"`), so signing in no longer downloads every transcript body. The sign-in key patch is regenerated for the new SDK version.
- d171ad6: Details: TC-1977 Revert storing connector credentials under app named keys: web sign-in with the named-key manifest could not complete in the OpenKey sign popup. It returns with a fix and a real-browser sign-in check.
- 4bbe96a: Update the TinyCloud SDK packages to 3.8.0-beta.1 (replica 0.3.5-beta.0) and request sign-in sync only on the declared replication prefixes (`replication.syncScope: "prefixes"`).

  Details: TC-2043

- 38b2c37: Meeting chat tools accept `exo-merged` (combined meetings) as a source filter.
- 8b6848e: Details: TC-1977 Store connector credentials in app named keys again. Web sign-in runs OpenKey's authorize review inside the embedded OpenKey frame, so it needs no popup or extra approval screen, and the web reads its manifest, with the named-key declaration, from its own /.well-known/openkey-manifest.json, the file OpenKey verifies. The backend's /api/manifest carries no key declaration.
- 6e64051: Combined-meeting summaries now use a faster model and a per-call output cap. The chat route accepts an optional `max_output_tokens` integer (1 to 4096), forwarded upstream as `max_tokens`. Details: TC-1686
- fa7f6d8: Agent chat turns now stay within the remaining daily credit budget. A pre-flight check compares remaining credits against the minimum turn cost (log-only by default, `AGENT_CHAT_BUDGET_PREFLIGHT=enforce` returns 402). An in-turn check on Eliza usage frames stops the turn according to `AGENT_CHAT_BUDGET_STOP_MODE`: `finish_answer` (default) finishes the answer in progress, bounded to one extra step; `hard_stop`, `predict_next_round`, and `off` are also available.
- 6312e16: Add an "Automatic meeting summaries" setting, on by default. When it is off, a combined meeting is saved without a summary and Generate starts one. `GET /api/billing/status` now reports the same usage the chat admission gate uses, and the client refreshes it after a summary run.
- a9a2e94: A voice note that Private transcription is holding shows "Transcription is delayed, it will finish automatically." instead of an error, and keeps checking until it finishes. A note whose Private transcription stopped on a speech-to-text provider failure is re-submitted once, automatically, the next time the app loads and the recording is still on the device; if it fails again it waits for Retry.

  Details: TC-2085

- d826e26: Turn on TinyCloud-hosted AssemblyAI transcription for the Powerful choice.
- ae0fbc6: Hide the TinyCloud button by default; add a Settings toggle and an Open row.

  Update TinyCloud SDK to 3.8.0-beta.12 (panel delegation button, iPhone safe areas).

- 7889a90: Add canonical RFC 9562 UUID v1–8 request IDs to backend HTTP responses and explicitly classified first-party ptx-dev/ptx-batch calls, with v4 replacement, a typed replacement flag, redirect isolation and request-scoped console/stream redaction. `REQUEST_ID_FIRST_PARTY_ORIGINS` independently controls request-ID forwarding and defaults to deny. Preserve unscoped stream write callbacks and the independent Private transcription correlation-ID header and error contract. [TC-959](https://linear.app/tinycloud-labs/issue/TC-959).

  Isolate the shared transcript delivery worker from initiating HTTP contexts and restore only each volatile queue item's own request ID. Recovery, retries and sweeps without a retained origin send no request ID; delivery state remains unchanged, with an explicit restart/retry correlation gap. Keep payload-safe diagnostics in both attributed item work and the detached shared lifecycle.

- fde135c: Update the TinyCloud SDK family to the stable 3.3.0 line (web-sdk, node-sdk, sdk-core, sdk-services 3.3.0; node-sdk-wasm 1.7.8; web-sdk-wasm 1.7.7) and regenerate the node-sdk sign-in patch for 3.3.0.

  Details: TC-1152

- 3e173ce: Move the TinyCloud SDK family to the stable 3.3.0 set (web-sdk, node-sdk, sdk-core, sdk-services 3.3.0; `@tinycloud/replica` 0.3.0; web-sdk-wasm 1.7.7; node-sdk-wasm 1.7.8). Add an optional local read-through copy of transcript text for the web app behind a build-time flag that defaults OFF: nothing changes unless the app is built with `VITE_EXO_REPLICATION=true` (the per-browser runtime opt-in exists only outside production builds), and it refuses to turn on in Tauri, Capacitor, iOS browsers, Safari and Firefox. With the flag OFF, a local copy left by an earlier build is removed at the next load. Mirrors only audio-free transcript folders, within a 100 MB budget; reads that confirm a write use the network. Sign-out erases the local copy (a failed erase is shown and blocks reads), and Settings shows a read-only status line. A built-in kill switch forces replication off for every build and browser.

## 0.5.7-beta.25

### Patch Changes

- 0cd762b: Send a notetaker accepts every Google Meet link shape: `/meet/<code>`, `/_meet/<code>`, `g.co/meet/<code>`, `tel.meet/<code>`, links wrapped in `accounts.google.com?continue=` or `meet.app.goo.gl?link=`, and a bare code with or without dashes. All become `https://meet.google.com/<code>` (lowercase, no trailing slash). A wrapper whose target is not a Meet link is refused. `meet.google.com/lookup/<nick>` is sent as pasted.

## 0.5.7-beta.24

### Patch Changes

- 8b6848e: Details: TC-1977 Store connector credentials in app named keys again. Web sign-in runs OpenKey's authorize review inside the embedded OpenKey frame, so it needs no popup or extra approval screen, and the web reads its manifest, with the named-key declaration, from its own /.well-known/openkey-manifest.json, the file OpenKey verifies. The backend's /api/manifest carries no key declaration.

## 0.5.7-beta.23

### Patch Changes

- d171ad6: Details: TC-1977 Revert storing connector credentials under app named keys: web sign-in with the named-key manifest could not complete in the OpenKey sign popup. It returns with a fix and a real-browser sign-in check.

## 0.5.7-beta.22

### Patch Changes

- b4c2b24: Home signs in with the permissions in its manifest, including the requested secret decrypt grant.

  Details: TC-2038

## 0.5.7-beta.21

### Patch Changes

- ae0fbc6: Hide the TinyCloud button by default; add a Settings toggle and an Open row.

  Update TinyCloud SDK to 3.8.0-beta.12 (panel delegation button, iPhone safe areas).

## 0.5.7-beta.20

### Patch Changes

- 3ac6081: The production backend CVM now runs a private log shipper sidecar. It sends startup lines (including `[startup] FATAL` and crash lines), hosted-AssemblyAI events and alerts to a private Better Stack source as typed fields only. It is inert until its source token is set, never gates the backend, and changes nothing for users.

## 0.5.7-beta.19

### Patch Changes

- 8b3b819: Hosted transcription refusals are now classified (rejected key, insufficient balance, rate limit) and reported to operators: one alert when AssemblyAI starts refusing, one when it recovers, one after three failed jobs in a row, a heartbeat every minute, and a read-only status for the monitoring probe. Nothing changes for users yet.
- d826e26: Turn on TinyCloud-hosted AssemblyAI transcription for the Powerful choice.

## 0.5.7-beta.18

### Patch Changes

- 0f22d69: Update the TinyCloud SDK packages to 3.8.0-beta.9 (replica 0.4.0-beta.3). The local copy now syncs entry names only and fetches a value when something reads it (`replication.contentFetch: "lazy"`), so signing in no longer downloads every transcript body. The sign-in key patch is regenerated for the new SDK version.

## 0.5.7-beta.17

### Patch Changes

- a9a2e94: A voice note that Private transcription is holding shows "Transcription is delayed, it will finish automatically." instead of an error, and keeps checking until it finishes. A note whose Private transcription stopped on a speech-to-text provider failure is re-submitted once, automatically, the next time the app loads and the recording is still on the device; if it fails again it waits for Retry.

  Details: TC-2085

## 0.5.7-beta.16

### Patch Changes

- 84819aa: Home signs in with the permissions in its manifest, including the requested secret decrypt grant.

  Details: TC-2038

## 0.5.7-beta.15

### Patch Changes

- 4bbe96a: Update the TinyCloud SDK packages to 3.8.0-beta.1 (replica 0.3.5-beta.0) and request sign-in sync only on the declared replication prefixes (`replication.syncScope: "prefixes"`).

  Details: TC-2043

## 0.5.7-beta.14

### Patch Changes

- 333a8f1: Show the notetaker stuck-joining state.

## 0.5.7-beta.13

### Patch Changes

- 813e839: Add an optional authenticated count of stored connector credentials, off unless a key is configured.

## 0.5.7-beta.12

### Patch Changes

- 648edff: Add an optional one-time row count for stored connector credentials, off by default.

## 0.5.7-beta.11

### Patch Changes

- 87993a3: With `EXO_CAPABILITIES_ENABLED` set to `true`, the Exo mailbox now runs on real stores. Cooldown, daily-count, and active-run state is kept in the backend KV with compare-and-set writes. Queued wakes drain on shutdown, expired job mirrors are swept hourly, and owner and source Exo state is cleared on grant revoke, transcript delegation revoke, calendar autojoin disconnect, and connector teardown. The flag remains off by default.

## 0.5.7-beta.10

### Patch Changes

- 73b3241: Activate exactly scoped Exo sync grants: KV get, list, and del on the `requests/` prefix, and get, put, and del on the `jobs/` prefix. A flag-gated grant route, `GET|POST|DELETE /api/exo/v1/grant`, mounts only when `EXO_CAPABILITIES_ENABLED` is exactly `true`. A typed accessor refuses traversal, encoded, sibling, and lookalike paths, keys over 512 characters, stored values over 4 KiB, and invalid UTF-8 or byte-order-marked values before any KV call. Exo and connector grant records are bound to their own kind and key prefix, and connector records written before this change still load. `EXO_CAPABILITIES_ENABLED` stays off by default.

## 0.5.7-beta.9

### Patch Changes

- eb888dd: Add a backend mailbox for Exo sync requests behind `EXO_CAPABILITIES_ENABLED`, which is off by default. The grant verifier now also accepts one exactly scoped Exo grant shape; connector grants are unchanged.

## 0.5.7-beta.8

### Patch Changes

- 57fb986: Send a notetaker accepts meeting links as people paste them. A link without `https://`, Google's `google.com/meet/<code>` form, a bare Meet code, a Gmail/Calendar or Outlook redirect, or a whole "Join with Google Meet" line now becomes the canonical meeting link before it goes to ptx. These used to fail with "That doesn't look like a meeting link" or "That meeting platform isn't supported yet". Any other link still goes upstream exactly as pasted, so capability links keep their query and fragment. The backend applies the same reading, so links from older clients work too.

## 0.5.7-beta.7

### Patch Changes

- 6312e16: Add an "Automatic meeting summaries" setting, on by default. When it is off, a combined meeting is saved without a summary and Generate starts one. `GET /api/billing/status` now reports the same usage the chat admission gate uses, and the client refreshes it after a summary run.

## 0.5.7-beta.6

### Patch Changes

- 3e173ce: Move the TinyCloud SDK family to the stable 3.3.0 set (web-sdk, node-sdk, sdk-core, sdk-services 3.3.0; `@tinycloud/replica` 0.3.0; web-sdk-wasm 1.7.7; node-sdk-wasm 1.7.8). Add an optional local read-through copy of transcript text for the web app behind a build-time flag that defaults OFF: nothing changes unless the app is built with `VITE_EXO_REPLICATION=true` (the per-browser runtime opt-in exists only outside production builds), and it refuses to turn on in Tauri, Capacitor, iOS browsers, Safari and Firefox. With the flag OFF, a local copy left by an earlier build is removed at the next load. Mirrors only audio-free transcript folders, within a 100 MB budget; reads that confirm a write use the network. Sign-out erases the local copy (a failed erase is shown and blocks reads), and Settings shows a read-only status line. A built-in kill switch forces replication off for every build and browser.

## 0.5.7-beta.5

### Patch Changes

- fa7f6d8: Agent chat turns now stay within the remaining daily credit budget. A pre-flight check compares remaining credits against the minimum turn cost (log-only by default, `AGENT_CHAT_BUDGET_PREFLIGHT=enforce` returns 402). An in-turn check on Eliza usage frames stops the turn according to `AGENT_CHAT_BUDGET_STOP_MODE`: `finish_answer` (default) finishes the answer in progress, bounded to one extra step; `hard_stop`, `predict_next_round`, and `off` are also available.

## 0.5.7-beta.4

### Patch Changes

- 6e64051: Combined-meeting summaries now use a faster model and a per-call output cap. The chat route accepts an optional `max_output_tokens` integer (1 to 4096), forwarded upstream as `max_tokens`. Details: TC-1686

## 0.5.7-beta.3

### Patch Changes

- fde135c: Update the TinyCloud SDK family to the stable 3.3.0 line (web-sdk, node-sdk, sdk-core, sdk-services 3.3.0; node-sdk-wasm 1.7.8; web-sdk-wasm 1.7.7) and regenerate the node-sdk sign-in patch for 3.3.0.

  Details: TC-1152

## 0.5.7-beta.2

### Patch Changes

- 38b2c37: Meeting chat tools accept `exo-merged` (combined meetings) as a source filter.

## 0.5.7-beta.1

### Patch Changes

- 1c140c0: Calendar autojoin now asks Google for Calendar events, openid and email only, and no longer asks for the Meet, Drive and Docs scopes or for previously granted scopes. Enabling it no longer saves a Google Meet token or runs a Meet sync; Google Meet stays a separate connect. Existing autojoin connections are not changed until the user reconnects.

## 0.5.7-beta.0

### Patch Changes

- 7889a90: Add canonical RFC 9562 UUID v1–8 request IDs to backend HTTP responses and explicitly classified first-party ptx-dev/ptx-batch calls, with v4 replacement, a typed replacement flag, redirect isolation and request-scoped console/stream redaction. `REQUEST_ID_FIRST_PARTY_ORIGINS` independently controls request-ID forwarding and defaults to deny. Preserve unscoped stream write callbacks and the independent Private transcription correlation-ID header and error contract. [TC-959](https://linear.app/tinycloud-labs/issue/TC-959).

  Isolate the shared transcript delivery worker from initiating HTTP contexts and restore only each volatile queue item's own request ID. Recovery, retries and sweeps without a retained origin send no request ID; delivery state remains unchanged, with an explicit restart/retry correlation gap. Keep payload-safe diagnostics in both attributed item work and the detached shared lifecycle.

## 0.5.6

### Patch Changes

- fa85621: Fix the Private transcription length boundary. Eligibility compares the unrounded note length with PTX's limit from `/capabilities`: `accepted_max_duration_seconds` (PTX's inclusive ceiling on measured duration) when present, otherwise `max_duration_seconds` plus the optional `duration_grace_seconds`. The client keeps a 0.25 s margin below the ceiling. Client-built WAVs are rechecked against the greater of the precise saved duration and exact decoded payload duration, and the latest byte cap is checked against the actual payload. Legacy integer durations use a conservative +0.5 s estimate. No Private limit is hard-coded; without a complete duration and byte advertisement Private is not offered. The backend relays the optional duration fields when PTX sends them; a client-only deploy is safe. Clock-style media durations floor fractional seconds consistently for the total and current position, and a refused Private start returns its refusal to the caller.
- a436537: Hosted AssemblyAI transcription is not available in 0.8.0. This release includes dedupe and durable-spool groundwork only; it takes effect in a future, separately approved rollout.
- 7a024fb: Relay validated optional PTX quiet-mode VAD diagnostics in transcription results.
- ada6d55: Keep calendar autojoin enabled when reconnecting the same Google account and explain why it is off in connector settings and Meeting sources.
- 42fbd33: Keep a shared Google grant when another live calendar autojoin account still uses it, while removing the disconnecting account's local credentials. Explain that Google access can be revoked from another TinyChat account or Google settings.
- 04a9e32: Replace the earlier auth audience check with signed SIWE audience validation.
- 2bfec5b: Validate the signed SIWE audience before issuing sessions and bound pending nonces.

## 0.5.6-beta.3

### Patch Changes

- fa85621: Fix the Private transcription length boundary. Eligibility compares the unrounded note length with PTX's limit from `/capabilities`: `accepted_max_duration_seconds` (PTX's inclusive ceiling on measured duration) when present, otherwise `max_duration_seconds` plus the optional `duration_grace_seconds`. The client keeps a 0.25 s margin below the ceiling. Client-built WAVs are rechecked against the greater of the precise saved duration and exact decoded payload duration, and the latest byte cap is checked against the actual payload. Legacy integer durations use a conservative +0.5 s estimate. No Private limit is hard-coded; without a complete duration and byte advertisement Private is not offered. The backend relays the optional duration fields when PTX sends them; a client-only deploy is safe. Clock-style media durations floor fractional seconds consistently for the total and current position, and a refused Private start returns its refusal to the caller.
- a436537: Hosted AssemblyAI transcription is not available in 0.8.0. This release includes dedupe and durable-spool groundwork only; it takes effect in a future, separately approved rollout.

## 0.5.6-beta.2

### Patch Changes

- 91a7981: Validate the signed SIWE audience before issuing sessions and bound pending nonces.

## 0.5.6-beta.1

### Patch Changes

- 04a9e32: Revert the auth verify audience check.

## 0.5.6-beta.0

### Patch Changes

- 2bfec5b: Validate the signed SIWE audience before issuing sessions and bound pending nonces.

## 0.5.5

### Patch Changes

- 7a024fb: Relay validated optional PTX quiet-mode VAD diagnostics in transcription results.
- ada6d55: Keep calendar autojoin enabled when reconnecting the same Google account and explain why it is off in connector settings and Meeting sources.
- 42fbd33: Keep a shared Google grant when another live calendar autojoin account still uses it, while removing the disconnecting account's local credentials. Explain that Google access can be revoked from another TinyChat account or Google settings.

## 0.5.5-beta.2

### Patch Changes

- 42fbd33: Keep a shared Google grant when another live calendar autojoin account still uses it, while removing the disconnecting account's local credentials. Explain that Google access can be revoked from another TinyChat account or Google settings.

## 0.5.5-beta.1

### Patch Changes

- ada6d55: Keep calendar autojoin enabled when reconnecting the same Google account and explain why it is off in connector settings and Meeting sources.

## 0.5.5-beta.0

### Patch Changes

- 7a024fb: Relay validated optional PTX quiet-mode VAD diagnostics in transcription results.

## 0.5.4

### Patch Changes

- 82fc4b7: Give each signed-in user their own rate-limit buckets. Every bucket is now keyed by the verified session address, not the client IP: in production the IP is the Phala gateway's for every client. Signed-in users get the pre-incident per-user ceilings (for example global 120 and paid chat 120 per 15 minutes). Requests without a valid session share one anonymous bucket at the 0.5.4 whole-service ceilings.

  The 0.5.4 ceilings stay in force as aggregates over all users for paid chat (600), private cloud job changes (300) and hosted uploads, so fresh wallets can't multiply them. Sign-in (`/api/auth`) has one bucket of 1,200 per 15 minutes whatever bearer a request carries, which bounds session minting. `X-Forwarded-For` no longer affects any rate-limit key.

- eb81c50: Stop the shared rate-limit key from taking every user down. In production every client reaches the backend from the Phala gateway's single address, so each rate-limit bucket is shared by all users. Interim, until per-client keying ships:
  - Polling and read buckets scale by 50: global 6,000 per 15 minutes.
  - Paid chat (`POST /api/chat`, `POST /api/agent/chat`) gets its own bucket of 600.
  - Google OAuth: 150. Private cloud job mutations: 300. Calendar autojoin: reads 3,000, setup 150. Delegations: 600.
  - Private cloud job-status polls leave the transcriber bucket for their own.
  - `/health` and `/health/` are exempt.
  - Paths are matched case-insensitively, so every request lands in exactly one bucket.
  - The routes charged to the global bucket are counted, logged every 5 minutes and shown on `/health`.

- d15a4ec: Stop publishing the backend's port 3001 on Phala; all traffic goes through the TLS ingress (TC-1012).
- 60e745c: Reduce PTX and hosted transcription status polling after the initial fast phase, honor rate-limit retry deadlines, expose limiter headers to browser clients, and keep throttling separate from failure budgets.
- 8021de8: Serve tenant-isolated last-known Calendar autojoin status on storage read failures, with bounded caching, mutation invalidation, retry guidance and metadata-only request timing.
- 96d83d8: Bound Calendar autojoin status to connection and worker-maintained outcome summary reads, preserving last-known fallback and immediate user policy changes, with the existing full history listing for legacy tenants until their first summary publication. Repair unreadable summaries and ensure optional projection failures cannot skip disconnect revocation.

## 0.5.4-beta.5

### Patch Changes

- 96d83d8: Bound Calendar autojoin status to connection and worker-maintained outcome summary reads, preserving last-known fallback and immediate user policy changes, with the existing full history listing for legacy tenants until their first summary publication. Repair unreadable summaries and ensure optional projection failures cannot skip disconnect revocation.

## 0.5.4-beta.4

### Patch Changes

- 60e745c: Reduce PTX and hosted transcription status polling after the initial fast phase, honor rate-limit retry deadlines, expose limiter headers to browser clients, and keep throttling separate from failure budgets.

## 0.5.4-beta.3

### Patch Changes

- 8021de8: Serve tenant-isolated last-known Calendar autojoin status on storage read failures, with bounded caching, mutation invalidation, retry guidance and metadata-only request timing.

## 0.5.4-beta.2

### Patch Changes

- 82fc4b7: Give each signed-in user their own rate-limit buckets. Every bucket is now keyed by the verified session address, not the client IP: in production the IP is the Phala gateway's for every client. Signed-in users get the pre-incident per-user ceilings (for example global 120 and paid chat 120 per 15 minutes). Requests without a valid session share one anonymous bucket at the 0.5.4 whole-service ceilings.

  The 0.5.4 ceilings stay in force as aggregates over all users for paid chat (600), private cloud job changes (300) and hosted uploads, so fresh wallets can't multiply them. Sign-in (`/api/auth`) has one bucket of 1,200 per 15 minutes whatever bearer a request carries, which bounds session minting. `X-Forwarded-For` no longer affects any rate-limit key.

## 0.5.4-beta.1

### Patch Changes

- d15a4ec: Stop publishing the backend's port 3001 on Phala; all traffic goes through the TLS ingress (TC-1012).

## 0.5.4-beta.0

### Patch Changes

- eb81c50: Stop the shared rate-limit key from taking every user down. In production every client reaches the backend from the Phala gateway's single address, so each rate-limit bucket is shared by all users. Interim, until per-client keying ships:
  - Polling and read buckets scale by 50: global 6,000 per 15 minutes.
  - Paid chat (`POST /api/chat`, `POST /api/agent/chat`) gets its own bucket of 600.
  - Google OAuth: 150. Private cloud job mutations: 300. Calendar autojoin: reads 3,000, setup 150. Delegations: 600.
  - Private cloud job-status polls leave the transcriber bucket for their own.
  - `/health` and `/health/` are exempt.
  - Paths are matched case-insensitively, so every request lands in exactly one bucket.
  - The routes charged to the global bucket are counted, logged every 5 minutes and shown on `/health`.

## 0.5.3

### Patch Changes

- b1b58a1: Open Google consent in the system browser on Exo Mac, receive the authorization code through a validated one-shot loopback listener, and exchange it using a Google Desktop OAuth client. Offer a same-tab return when a web popup is blocked.
- 1834edf: TC-1016: reuse notetaker send idempotency keys across retries and coalesce active or concurrent sends for the same meeting URL.
- c34ce99: (TC-1047, TC-988) Calendar auto-join sends a meeting at its due time from a per-occurrence timer, instead of whenever the next worker tick (about 2 minutes on prod) reaches it; ticks remain the backstop. One occurrence's dispatch path (its reads, capture claims, the intent write and the post-send writes) runs at request lane priority. Each tick logs `code=tick_done` with its duration and tenant, row, scan and timer counts.

## 0.5.3-beta.2

### Patch Changes

- b1b58a1: Open Google consent in the system browser on Exo Mac, receive the authorization code through a validated one-shot loopback listener, and exchange it using a Google Desktop OAuth client. Offer a same-tab return when a web popup is blocked.

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
