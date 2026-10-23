# TinyChat Connectors — v1 Spec (Fireflies first)

Status: authoritative for the `feature/connectors` branch. Written 2026-07-30 from a
three-way scout of tinychat, `listen` (buggy reference — copy ideas, not code), and
`fireflies-sync` (clean minimal reference), plus a live CORS probe of the Fireflies API.

## 1. Goal

Users connect external data sources ("connectors") and their data is synced into the
user's own TinyCloud space. v1 ships the **general connectors architecture + settings UI**
and **one working connector: Fireflies.ai** (meeting transcripts). v1 only **stores** the
data; wiring it into chat context comes later — but every design choice below must keep
that future in mind (normalized, queryable storage; per-meeting summaries available
without loading full transcripts).

Non-goals for v1: chat-context injection, webhooks, audio download (TinyCloud KV binary
support is an unresolved interim hack — see listen TC-1366/68), backend involvement of
any kind, mobile.

## 2. Locked decisions (operator-approved)

1. **Client-driven sync.** The browser talks to the Fireflies GraphQL API directly.
   CORS is confirmed open (probe 2026-07-30: `access-control-allow-origin: *`,
   `access-control-allow-headers: authorization,content-type` on preflight). There is
   **no backend route, no proxy, no manifest change**. The API key never leaves the
   browser except to Fireflies itself.
2. **API key custody = TinyCloud Secrets** (`tcw.secrets`, first-class in
   `@tinycloud/web-sdk@2.5.1` which tinychat already uses). Never localStorage, never
   plain KV, never the backend.
3. **UI = a "Connectors" SectionCard** in the existing `frontend/src/chat/SettingsPage.tsx`,
   plus one Radix dialog. Web only. Match the existing design language exactly — no new
   aesthetic (follow `ImportDialog.tsx` conventions).
4. **Data lands in the user's space**: SQL for meeting metadata + sync state, KV for
   transcript bodies.

## 3. File layout (AUTHORITATIVE — do not invent other paths)

New files:

- `frontend/src/lib/connectors/types.ts` — shared types + connector registry types
- `frontend/src/lib/connectors/registry.ts` — static registry of available connectors
- `frontend/src/lib/connectors/firefliesClient.ts` — Fireflies GraphQL client (pure, fetch-injectable)
- `frontend/src/lib/connectors/connectorStore.ts` — SQL/KV persistence + sync state
- `frontend/src/lib/connectors/connectorSecrets.ts` — thin `tcw.secrets` wrapper
- `frontend/src/lib/connectors/firefliesSync.ts` — sync engine (client+store+secrets injected)
- `frontend/src/lib/connectors/*.test.ts` — colocated bun unit tests
- `frontend/src/chat/ConnectorsCard.tsx` — the SectionCard for SettingsPage
- `frontend/src/chat/ConnectorDialog.tsx` — connect/manage dialog
- `test/connectors/mock-fireflies.mjs` — mock Fireflies GraphQL upstream (HTTP server)
- `test/connectors/fake-tinycloud.ts` — in-memory fake of the SQL/KV/secrets surfaces
- `test/connectors/*.e2e.test.ts` — e2e drivers (bun test) against the real mock upstream
- `test/connectors/browser-lane.ts` — browser-e2e lane (Playwright, headed Chrome) — see §10

Modified files (minimal edits only):

- `frontend/src/chat/SettingsPage.tsx` — mount `ConnectorsCard`
- `package.json` (root) — add `"test:connectors"` and `"test:connectors:browser"`
- `test/package.json` — add the `connectors:browser` script
- `frontend/src/vite-env.d.ts` — type `VITE_FIREFLIES_API_URL` / `VITE_FIREFLIES_DELAY_MS`
- `frontend/src/App.tsx` — dev-only `window.__tcw` probe seam for the browser lane
  (guarded by `import.meta.env.DEV`, so it is absent from production bundles)

NEVER: touch `mobile/`, the threads SQL schema, or create new top-level directories.

### 3a. Sanctioned exceptions to the original allowlist (amended)

This section originally read "NEVER touch `backend/` or `manifest.json`". That rule
was written before the secrets-escalation and browser-e2e work, and reality has
outgrown it. The exceptions below are deliberate and reviewed; nothing else in
`backend/` or `manifest.json` is in scope.

- `manifest.json` — the connectors secrets grant. `tcw.secrets.put` cannot escalate
  without the capability being present in the app manifest (commits `b614a8e`,
  `ecc84c1`).
- `backend/` — the manifest-pin test only, which asserts the served manifest still
  carries that grant.
- `frontend/src/App.tsx` — restores the stored manifest on boot so a restored
  session can escalate, plus the dev-only `__tcw` probe seam described above.

The browser lane additionally requires a test seam in otherwise-pure product code:
`firefliesClient.ts` exports `resolveFirefliesClientDefaults` /
`defaultFirefliesClientOptions`, read at all three UI construction sites, so the lane
can retarget the client at the mock upstream. With the env vars unset the resolver
returns the production endpoint and the production 800 ms pacing, so shipped
behaviour is unchanged.

## 4. Connectors architecture

`types.ts` defines a small, honest abstraction — enough for a registry UI and a second
connector later, no speculative plugin machinery:

```ts
type ConnectorId = "fireflies" | "granola" | "google-meet";

interface ConnectorDescriptor {
  id: ConnectorId;
  name: string; // "Fireflies"
  description: string; // one line, user-facing
  status: "available" | "coming-soon";
  secretName: string; // "FIREFLIES_API_KEY"
  secretScope?: string; // scoped OAuth/session credentials only
}

interface ConnectorConnection {
  connectorId: ConnectorId;
  status: "connected" | "disconnected";
  lastSyncedAt: string | null; // ISO; Fireflies stores last complete listing success
  lastSyncStatus: "ok" | "partial" | "error" | null;
  lastSyncError: string | null;
  itemCount: number;
}

interface SyncProgress {
  phase: "listing" | "fetching" | "storing";
  done: number;
  total: number | null;
}

interface SyncResult {
  added: number;
  skipped: number;
  errors: string[];
}
```

`registry.ts` exports `CONNECTORS: ConnectorDescriptor[]` — Fireflies (`available`),
Granola + Google Meet (`coming-soon`, rendered greyed out, non-interactive).

All persistence/service modules follow the tinychat house pattern: **return `Result`-style
objects, never throw across module boundaries** (see `threadStore.ts`).

This rule is scoped to the **frontend** connector modules above. The **backend** connector
services (`backend/src/services/connector-queue.ts`, `webhook-tokens.ts`, `connector-drain.ts`)
deliberately REJECT instead: their callers are Express handlers whose §4.3 requirement is that
nothing may leave a request unanswered or throw out of the handler, so every call site is already
inside a `try`/`catch` that maps a failure to a status code, and a second `{ok:false}` channel
alongside it would be a second thing to forget to check. The `{ok, …}` shape is used where a
result is _inspected_ rather than propagated — `validateConnectorWebhookSecrets` (startup gate)
and `createStoredDelegationGate.validate` (a per-address verdict that is _inspected_; under
Option C the drain does not wire it — see `docs/connector-webhooks-delegation-gate.md`).

## 5. Fireflies GraphQL client (`firefliesClient.ts`)

Endpoint: `https://api.fireflies.ai/graphql` (module-level const, overridable via
constructor option `apiUrl` — the e2e rig points it at the mock upstream). Auth:
`Authorization: Bearer <key>`. Constructor takes `{ apiKey, apiUrl?, fetchImpl?, delayMs? }`
so unit tests inject a mock fetch and e2e uses the real one.

Operations (query strings verbatim from the proven `listen` implementation):

```graphql
query GetUser {
  user {
    name
    email
  }
}

query ListTranscripts($limit: Int, $skip: Int) {
  transcripts(limit: $limit, skip: $skip) {
    id
    title
    date
    duration
    organizer_email
  }
}

query GetTranscript($id: String!) {
  transcript(id: $id) {
    id
    title
    date
    duration
    organizer_email
    speakers {
      id
      name
    }
    meeting_attendees {
      displayName
      email
    }
    sentences {
      index
      speaker_name
      text
      start_time
      end_time
    }
    summary {
      keywords
      action_items
      overview
      meeting_type
    }
  }
}
```

- `validateKey()` → runs `GetUser`; distinguishes `invalid-key` (GraphQL auth error /
  401/403) from `network-error` — the connect dialog shows different messages.
- `listNewTranscriptIds(...)` lists newest-first, skips known IDs rather than
  stopping at the first known row, and reports whether the date boundary or true
  end of history was reached. Every run uses the same behavior. The listing is
  bounded by 20 provider pages and at most 50 detail fetches; the exclusive date
  boundary is `last_synced_at - 24 h`. With no watermark, only those budgets bound
  the initial listing.
- `getTranscript(id)` — full detail fetch. The sync engine sleeps `delayMs` **between
  detail fetches too** (listen bug: it only slept in the list loop and could burst-hit
  rate limits on backfill).

Rate limiting:

- HTTP 429 and GraphQL rate-limit responses retry at most 3 times. Retry-After
  waits are abortable; delays above 60 seconds stop the run as partial rather
  than holding a sync or disconnect open indefinitely.
- On exhaustion return a typed `rate-limited` error carrying `retryAfterMs`.

## 6. Storage (`connectorStore.ts`)

SQL database handle: `tcw.sql.db("xyz.tinycloud.tinychat/connectors")`.
**Gotcha (from `threadStore.ts:16-22`): resource paths are sent verbatim — neither SQL
nor KV app-prefixes for you, so the full `${APP_ID}/connectors` string is required or
every call 401s.** The manifest's `prefix` defaults to `app_id`, so a manifest
permission on `connectors` grants `${APP_ID}/connectors`; the requested path has to
match that string. Reuse the `APP_ID` const. Schema bootstrap memoized per space keyed by
`tcw.did` (NOT spaceId — spaceId is undefined on a restored session), exactly like
`threadStore.ts` does with `schemaReadySpaces`.

**TinyCloud SQLite authorizer restrictions (hard constraints, from listen):** no
`CREATE INDEX`, no `UNIQUE` constraints, no `REFERENCES`. Dedup is app-level. Also:
`CREATE TABLE IF NOT EXISTS` can return "not authorized" when the table already exists —
on that error, probe with `SELECT 1 FROM <table> LIMIT 1` and treat success as
"schema ready" (copy listen's `ensureSchema` fallback).

```sql
CREATE TABLE IF NOT EXISTS connector_state (
  connector_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_synced_at TEXT,
  last_sync_status TEXT,
  last_sync_error TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_meeting (
  id TEXT PRIMARY KEY,             -- crypto.randomUUID(); Fireflies id lives in source_id
  source TEXT NOT NULL,            -- 'fireflies'
  source_id TEXT NOT NULL,
  title TEXT,
  started_at TEXT,                 -- ISO
  duration_secs REAL,
  organizer_email TEXT,
  participants TEXT,               -- JSON array of {name, email|null}
  summary_overview TEXT,
  summary_action_items TEXT,
  keywords TEXT,                   -- JSON array
  meeting_type TEXT,
  metadata TEXT,                   -- JSON blob (forward-compat)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

For Fireflies, `connector_state.last_synced_at` is the authoritative last-success
watermark; UI staleness is derived from it at read time (24 hours). Failed, partial,
aborted, truncated, and targeted webhook-ingest runs never advance it. Attempt metadata
is advisory KV at `${APP_ID}/connectors/fireflies/sync-attempt`, written only by the
Fireflies sync engine as a JSON string, for example:
`{"v":1,"last_attempt_at":"2026-10-13T12:00:00.000Z","last_attempt_status":"partial","listing_skip":50,"listing_started_at":"2026-10-13T10:00:00.000Z","listing_anchor":"transcript-49","listing_anchor_date":1791892800000,"listing_previous_neighbor":"transcript-48","pending_ids":["failed-transcript"],"suspect_ids":["failed-transcript"],"suspect_seen_ids":[],"suspect_proof_ids":["failed-transcript"],"suspect_proof_at":"2026-10-13T11:00:00.000Z"}`.
Readers accept JSON strings and SDK-decoded objects. `pending_ids` is capped at 50;
each run retries up to half the detail budget (maximum 25, minimum 1 for a positive
budget), rotating failures so listing retains its budget. Pending IDs keep the SQL
watermark from advancing until empty. A `running` record older than 15 minutes is
abandoned and no longer paces catch-up. SQL `last_synced_at` remains authoritative;
this KV record is only advisory pacing and bounded-list continuation.
Existing SQL rows need no migration.

The Connectors UI shows “Stale since <date>” when the SQL watermark is older than
24 hours. A stale Fireflies connector gets a bounded full-listing reconcile (at most
50 unseen transcript details) on mount or successful unlock, including when the
webhook route is dark. It is paced at one attempt per 15 minutes per account and
does not run on focus. Catch-up skips known IDs but continues paging past them until
it reaches the watermark minus a 24-hour lag buffer, subject to the 50-item cap.
Webhook-targeted ingest preserves `last_synced_at`; only a complete full-listing
reconcile advances it.

Transcript bodies (sentences array) go to KV, **not** SQL:
`tcw.kv` key `xyz.tinycloud.tinychat/connectors/fireflies/transcript/<source_id>` → JSON
string of the sentences array. KV keys are sent verbatim just like SQL db names, so the
key carries the full `${APP_ID}/connectors/` prefix that the manifest's `connectors/`
grant resolves to. Build keys through `transcriptKvKey()` — the prefix lives in exactly
one place (`CONNECTORS_KV_PREFIX`).

Store API (all take `tcw` as first arg, mirror `threadStore` style):
`ensureSchema`, `getConnection(connectorId)`, `listKnownSourceIds(source)`,
`listTranscriptBodyIds(source)`, `insertMeeting(normalized)` (skip if `(source, source_id)`
already present — app-level dedup, SELECT-before-INSERT is fine since writes are sequential),
`putTranscriptBody(sourceId, sentences)`, `updateSyncState(...)`,
`getFirefliesAttempt()`, `recordFirefliesAttempt(...)`, `clearFirefliesAttempt()`,
`purgeConnector(source)` (delete meeting rows + KV meeting/transcript keys + Drive cursor +
Fireflies `sync-attempt` + state row), `countMeetings(source)`.

**Sequential writes only** — TinyCloud drops concurrent responses (known platform
gotcha; ImportDialog imports sequentially for the same reason).

### Normalization (from raw `GetTranscript`)

- `started_at = new Date(raw.date).toISOString()`.
- **`duration` is empirically MINUTES (undocumented).** Compute
  `durationSecs = Math.round(raw.duration * 60)`, then cross-check against the last
  sentence's `end_time` (seconds): if `|durationSecs - lastEndTime| > max(120, 0.5 * lastEndTime)`
  and `lastEndTime > 0`, prefer `lastEndTime` and record `duration_source: "sentences"`
  in `metadata`. (listen hardcoded `*60` on inference alone; we defend against the unit
  changing under us.)
- Participants: merge `meeting_attendees` (displayName/email) with speaker names;
  dedupe by name, first occurrence wins; email is best-effort `null` when names don't
  match — do NOT invent fuzzy matching (listen's exact-match silently loses emails;
  we accept that honestly rather than guessing).
- Keywords/action_items/overview/meeting_type from `summary` (all nullable — Fireflies
  summaries can lag transcripts; store nulls, don't fail the meeting).

## 7. Secrets (`connectorSecrets.ts`)

Thin wrapper over `tcw.secrets` (`ISecretsService`):

- `unlockSecrets(tcw)` → `tcw.secrets.unlock()` (wallet signature; SDK caches it —
  subsequent unlocks in the session are popup-free). Surface `isUnlocked`.
- `saveConnectorKey(tcw, descriptor, key)` → `tcw.secrets.put(descriptor.secretName,
key, descriptor.secretScope ? { scope: descriptor.secretScope } : undefined)`.
  Source keys use the global Listen-compatible names `FIREFLIES_API_KEY` and
  `GRANOLA_API_KEY`; OAuth/session credentials such as Google Meet's
  `REFRESH_TOKEN` remain connector-scoped. Secret names MUST match
  `/^[A-Z][A-Z0-9_]*$/`.
- `readConnectorKey(tcw, descriptor, { interactive })`, `deleteConnectorKey` — same pattern via `.get`/`.delete`. The `interactive` flag has no default.
- All SDK calls return `Result<T, E>` objects (`{ok, data|error}`) — propagate, never throw.
- **First-put 404 defense**: the node-sdk docs note a valid session can still 404 on the
  first `secrets.put` if the dedicated `secrets` space was never hosted. If `put` fails
  with a not-found-shaped error, call `tcw.ensureOwnedSpaceHosted?.("secrets")` if the
  method exists, then retry once. If the method doesn't exist on web-sdk, surface the
  error honestly (no silent fallback — debugging rule).
- **Every action the connector needs is granted at sign-in consent, except decrypt.**
  Decrypt is requested at read time (see below). On web-sdk 3.3.0, a restored session has
  no signer, so escalation through
  `grantRuntimePermissions` fails with "grantRuntimePermissions requires wallet mode with
  a signer or privateKey". The `secrets` shorthand therefore grants `delete` at sign-in
  (rationale in `backend/src/__tests__/manifest.test.ts`). Whether the decrypt
  `requestPermissions` succeeds for a restored session on the pinned SDK is unverified
  until the live QA run.

**Secrets reads request decrypt separately.** Sign-in requests only
`tinycloud.encryption` / `network.create` on the owner's default encryption network
(`lib/connectors/encryptionGrant.ts`). The network is created on the first save by
`ensureEncryptionNetwork` in `connectorSecrets.ts`, once per session.

Reading a stored key needs a separate decrypt grant. `readConnectorKey` in `connectorSecrets.ts`
takes an explicit `interactive` flag. Only explicit user actions (Sync now, Disconnect, Meeting
sources sync, and the queued-meetings sync) pass `interactive: true`, and only that path may request
the grant through `ensureDecryptStepUp`. The grant is exactly one `tinycloud.encryption` / `decrypt`
entry on the default network, with an expiry of `DECRYPT_STEP_UP_EXPIRY_MS` (3,540,000 ms, under one
hour). A background read (mount drain, focus catch-up, Google Meet session sync, Fireflies catch-up)
passes `interactive: false` and never prompts. Without a held grant it returns `needs-unlock`
(`NEEDS_UNLOCK_MESSAGE`) before any SDK call. The connector shows its locked state, and the next
explicit action retries. A declined request returns `decrypt-declined` and reads nothing. The request
is not retried.

A restored session gets a lazy EIP-1193 provider (`createLazyWalletProvider` in
`frontend/src/lib/lazyWalletProvider.ts`, passed in the restore config at
`frontend/src/App.tsx`). `restoreTinyCloudWebSession` (`packages/client/src/tinycloud.ts`) sets
the provider only when one is passed, so the restored client has a signer. The provider answers
`eth_accounts` and `eth_requestAccounts` with the stored address without opening the wallet. The
first other request (the signature for the decrypt step-up, or `eth_chainId`) opens OpenKey once.
A wallet for a different address rejects with `WALLET_ACCOUNT_MISMATCH_MESSAGE`. A failed open is
not cached, so the next request retries it.

`ensureDecryptStepUp` checks `hasPermissions` first and returns with no prompt when the grant is
held. With no grant and `interactive: false`, it returns `needs-unlock` and makes no SDK call. With
`interactive: true` it checks `isWalletConnected` next. A client without a signer returns
`wallet-unavailable` (`WALLET_UNAVAILABLE_MESSAGE`) before any prompt, because `requestPermissions`
throws on such a client. After a reload, the first explicit reveal shows the SDK permission prompt,
then the OpenKey signature. A later explicit reveal within the hour shows neither.

`readConnectorKey` is the only read path. A lint test fails if any other source file calls
`secrets.get` directly. A second guard fails if any `readConnectorKey` call site omits the
`interactive` flag. It checks that the flag is present, not its value, so each caller's value is
reviewed where it is written. KV reads come from the sign-in session's manifest, which grants
`tinycloud.kv` `get` on the vault paths. The step-up never adds KV entries; a regression test
enforces this.

Sessions created before this change may still hold the older decrypt grant. This change
does not revoke it.

**SDK pin.** This PR builds against `@tinycloud/web-sdk` 3.5.0.

## 8. Sync engine (`firefliesSync.ts`)

`syncFireflies({ client, store, tcw, onProgress, signal })` uses one listing
algorithm for Connect, Sync now, the background catch-up, and Meeting sources:

1. Read SQL `connector_state.last_synced_at` as the authoritative last-success
   watermark. List newest-first, skip known IDs (a SQL row whose KV body is
   missing is not complete), and stop at the exclusive date boundary
   `last_synced_at - 24 h`. With a NULL watermark, there is no date boundary.
2. Every run is bounded by 20 provider pages and at most 50 transcript details.
   A listing is complete only after reaching the date boundary or true end of
   history. Exhausting either budget is partial, not success.
3. Fetch details outside the shared space lane. At each item boundary, write the
   SQL row and KV body together inside the lane; after the item starts, finish
   both writes before honoring abort. Recheck account generation inside queued
   callbacks and before state writes.
4. Only a complete listing with no item errors, abort, or terminal error advances
   `last_synced_at`. Incomplete/error/aborted runs preserve it, including NULL on
   the first failed or partial insert. Targeted webhook ingest writes no success
   watermark; its successful Fireflies status is `partial` until a listing
   reconcile completes.
5. One single-flight is shared by Connect/reconnect, Sync now, and catch-up in a
   tab. Disconnect aborts the catch-up and waits for the active item boundary
   before purge/teardown. Connect explicitly authorizes reactivating a retained
   disconnected row; ordinary runs cannot write `connected` over disconnect or
   purge.
6. The per-space KV attempt record is
   `${APP_ID}/connectors/fireflies/sync-attempt`, version `v: 1`, with
   `listing_skip`, `listing_started_at`, `listing_anchor`,
   `listing_anchor_date`, `listing_previous_neighbor`, `pending_ids`,
   `suspect_ids`, `suspect_seen_ids`, `suspect_proof_ids`, `suspect_proof_at`,
   and `suspect_proof_at_by_id`. Attempt writes are best-effort and written only by the
   sync engine. Their failure does not change sync or ingest outcomes and cannot
   make an unpersisted cursor resumable. Connect's stale-record clear is also
   best-effort. Keep-data Disconnect has a separate, explicit continuation-clear
   step; its failure is retryable and may defer disconnect completion. A
   `running` record older than 15 minutes is abandoned.
   `pending_ids` is capped at 50. Each run retries at most
   `max(1, min(25, floor(detailCap / 2)))` pending IDs when `detailCap >= 1`,
   rotating failed IDs to the end so listing retains its budget. If adding another
   failure would exceed the cap, or a failure cannot otherwise be recorded, the
   old cursor remains unchanged. A detail error never proves deletion: a pending
   null transcript, HTTP 404, or GraphQL error with
   `extensions.code === "object_not_found"` or `extensions.status === 404` is
   not-found evidence; arbitrary error-message text is not.
   A pending not-found retry becomes suspect. Its proof listing uses the same
   bounded continuation and budgets but has no date cutoff, so only reaching the
   true end of history proves absence. A complete proof drops suspects absent
   from its summaries and restarts the listing at zero while retaining
   `listing_started_at`. Suspects seen during a completed proof are demoted to
   plain pending and their seen state is cleared; they can start a fresh proof if
   a later retry is not-found. `suspect_proof_at_by_id` stores the completion time
   of the last proof that observed each pending ID, with at most 50 entries. An
   ID without a proof in the preceding 24 hours may trigger a new proof. When a
   due ID starts a proof, every not-found retry from that invocation joins its
   fixed membership, including IDs still cooling down; later arrivals wait for a
   subsequent skip-zero generation. Completion updates each observed member's
   timestamp without resetting other IDs' cooldowns. On legacy records missing
   the map, valid `suspect_proof_at` seeds it, otherwise valid `last_attempt_at`;
   if neither is valid, there is no inherited cooldown. Every attempt write
   prunes the map to current `pending_ids`. Invalid map data drops the
   continuation cursor but preserves pending IDs. These additive `v: 1` fields
   allow older records to remain readable. The SQL watermark never advances while
   `pending_ids` is non-empty.
   `listing_started_at` is recorded at skip zero and becomes `last_synced_at` only
   after the whole ordinary chain reaches the date boundary or true end of history
   without item errors, abort, budget exhaustion, or pending IDs.
   The cursor binds `listing_skip - 1` to its ID, listed date, and immediately
   preceding neighbor. On mismatch the client searches a bounded window at least
   one page in each direction; it rebases only when all three match at exactly one
   position. Missing, duplicate, or mismatched evidence restarts from zero. If the
   KV record is lost, the next run restarts at the newest page and remains bounded.
   Connect over a missing/disconnected row and keep-data Disconnect clear the
   continuation and per-ID proof history; purge deletes `sync-attempt`. SQL
   `last_synced_at` remains authoritative; the KV record is advisory only.
7. Same-tab single-flight does not prevent cross-tab Sync now overlap. Cross-tab
   deduplication is out of scope: TinyCloud user SQL does not support a unique
   index, so this build does not claim cross-tab serialization. Cross-tab purge
   resurrection is part of this same limitation.
8. A background catch-up starts only on mount or unlock when Fireflies is
   connected, secrets are already unlocked, and SQL success is older than 24 h.
   Focus only drains queued webhook IDs. In the default route-dark deployment,
   stale mount/unlock reconciliation still runs; webhook probing/draining is
   dark. Connect, Sync now, and Meeting sources sync also run the same listing
   reconcile when explicitly invoked. Server-side ingest without an open tab is
   out of scope (TC-641).
9. `last_synced_at` is a trustworthy success watermark only after all clients
   have upgraded to this build; older clients may have written it on targeted
   webhook attempts. The 24 h lag bound intentionally revisits recent history
   to reconcile webhook holes. Holes older than `W − 24 h` that predate upgrade
   are never reconciled, and transcripts appearing later with dates older than
   the boundary are skipped permanently. Reconnecting a kept row under a
   different Fireflies account reuses its prior watermark; use Disconnect with
   delete-data before switching accounts. Keep-data Disconnect retains rows,
   transcript bodies, and the SQL success watermark, but clears the continuation
   so reconnect starts a bounded reconcile from the current listing top.
   A persistently failing transcript remains in `pending_ids`, keeps the run partial and the
   connector stale, while pending retries rotate and the listing continues through older
   history. Once stored, a later run clears the pending entry and may complete the reconcile.

## 9. UI

### `ConnectorsCard.tsx` (mounted in SettingsPage, near the Data/import card)

- Section title "Connectors", subtitle: "Connect external sources. Synced data is
  stored in your space." (Only the API key in `tcw.secrets` is AES-encrypted;
  SQL/KV rows live in the user's own space but are not encrypted at rest — keep
  copy honest.)
- One row/card per registry entry: icon, name, description.
  - `coming-soon` → greyed, "Coming soon" badge, non-interactive.
  - `available` + disconnected → "Connect" button → opens `ConnectorDialog`.
  - connected → status line ("Last synced 5 min ago · 42 meetings" or
    "Stale since <date> · 42 meetings"), `Sync now` button (spinner + inline
    progress "Syncing 3/12…" while running, driven by `onProgress`), overflow/
    secondary action "Disconnect".
- Connection state loaded from `connectorStore.getConnection` on mount (no secrets
  unlock needed just to render — never trigger a wallet popup on page load).

### `ConnectorDialog.tsx` (Radix Dialog, ImportDialog conventions)

Connect flow (stepper-lite, one dialog):

1. **Key entry**: password-type input, helper text linking to
   `https://app.fireflies.ai/integrations/custom/fireflies` ("Find your API key here"),
   Cancel/Continue.
2. **Validate**: `client.validateKey()` — invalid key and network errors show distinct
   inline messages; never store an unvalidated key.
3. **Store**: `unlockSecrets` (explain: "TinyCloud will ask for a signature to unlock
   your encrypted secrets") → `saveConnectorKey`.
4. **Initial sync**: runs immediately with progress ("Found 12 meetings… syncing 3/12");
   done state shows summary ("42 meetings synced") + Close. Sync failure here leaves
   the connector connected-with-error (key is saved; user can retry Sync now).

Disconnect flow (from the card): confirm dialog (AlertDialog) with a checkbox
"Also delete the 42 synced meetings from my space" (default OFF). Confirm →
`deleteConnectorKey` (+ `purgeConnector` when checked) → state row updated.
Copy must be precise about what is and isn't deleted.

All states keyboard-reachable; buttons disabled while operations run; no layout jank.

## 10. Testing & e2e (mock-only tonight — operator decision)

- **Unit** (colocated, mocked fetch / fake tcw): client pagination + early-exit + both
  rate-limit paths; normalization (duration cross-check, participant dedupe, null
  summary); store dedup + purge; secrets wrapper Result plumbing; sync engine
  orchestration incl. abort + per-item error skip.
- **Mock upstream** (`test/connectors/mock-fireflies.mjs`): plain `Bun.serve` GraphQL
  endpoint implementing `user`, `transcripts(limit, skip)` (newest-first, seeded ~30
  transcripts), `transcript(id)`. Modes via headers/env: happy, `invalid-key` (rejects
  bearer), `rate-limit-429` (one 429 + retry-after then succeed), `rate-limit-graphql`
  (GraphQL too_many_requests once then succeed). Seeded data includes one transcript
  with `duration` in minutes that mismatches sentence end_times (exercises the
  cross-check) and one with a null summary.
- **E2E drivers** (`test/connectors/*.e2e.test.ts`, bun test, real HTTP to the mock,
  real sync engine + real store code against `fake-tinycloud.ts`):
  1. `connect.e2e.test.ts` — validateKey happy + invalid-key; key lands in fake
     secrets at the global Listen-compatible name, never in KV/SQL.
  2. `sync.e2e.test.ts` — initial sync stores all seeded meetings (SQL rows + KV
     bodies match seed); second sync is a no-op (early-exit, 0 added); new upstream
     transcript → incremental picks up exactly 1; duration cross-check applied.
  3. `ratelimit.e2e.test.ts` — both 429 and GraphQL rate-limit modes recover and
     complete; exhaustion surfaces typed `rate-limited` with `retryAfterMs`.
  4. `disconnect.e2e.test.ts` — disconnect deletes secret; purge removes SQL rows +
     KV keys + state; without purge, data survives.
  - **Vacuity guard**: every driver asserts a non-zero baseline first (e.g. seeded
    count > 0) so a broken mock can't produce green tests.
- Full suite: root `bun run test` must stay green; `bun run lint`, `bun run
build:frontend` green.

## 11. Future (design for, don't build)

- Chat context: `connector_meeting` summaries are cheap to query per-thread; a future
  `contextProvider` hook on `ConnectorDescriptor` will feed summaries/transcript
  excerpts into the system prompt (like `memory.ts` does).
- Webhook-driven freshness needs backend + portable delegation (listen has the full
  pattern: HMAC verify, pending queue, delegation store) — explicitly out of scope v1.
- More connectors: Granola, Google Meet (listed as coming-soon in the registry).
