# @tinychat/backend

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
