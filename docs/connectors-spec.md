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
  name: string;              // "Fireflies"
  description: string;       // one line, user-facing
  status: "available" | "coming-soon";
  secretName: string;        // "API_KEY"
  secretScope: string;       // === id
}

interface ConnectorConnection {
  connectorId: ConnectorId;
  status: "connected" | "disconnected";
  lastSyncedAt: string | null;   // ISO
  lastSyncStatus: "ok" | "error" | null;
  lastSyncError: string | null;
  itemCount: number;
}

interface SyncProgress { phase: "listing" | "fetching" | "storing"; done: number; total: number | null; }

interface SyncResult { added: number; skipped: number; errors: string[]; }
```

`registry.ts` exports `CONNECTORS: ConnectorDescriptor[]` — Fireflies (`available`),
Granola + Google Meet (`coming-soon`, rendered greyed out, non-interactive).

All persistence/service modules follow the tinychat house pattern: **return `Result`-style
objects, never throw across module boundaries** (see `threadStore.ts`).

## 5. Fireflies GraphQL client (`firefliesClient.ts`)

Endpoint: `https://api.fireflies.ai/graphql` (module-level const, overridable via
constructor option `apiUrl` — the e2e rig points it at the mock upstream). Auth:
`Authorization: Bearer <key>`. Constructor takes `{ apiKey, apiUrl?, fetchImpl?, delayMs? }`
so unit tests inject a mock fetch and e2e uses the real one.

Operations (query strings verbatim from the proven `listen` implementation):

```graphql
query GetUser { user { name email } }

query ListTranscripts($limit: Int, $skip: Int) {
  transcripts(limit: $limit, skip: $skip) { id title date duration organizer_email }
}

query GetTranscript($id: String!) {
  transcript(id: $id) {
    id title date duration organizer_email
    speakers { id name }
    meeting_attendees { displayName email }
    sentences { index speaker_name text start_time end_time }
    summary { keywords action_items overview meeting_type }
  }
}
```

- `validateKey()` → runs `GetUser`; distinguishes `invalid-key` (GraphQL auth error /
  401/403) from `network-error` — the connect dialog shows different messages.
- `listNewTranscriptIds({ knownIds, batchSize = 25, onProgress })` — pages
  `ListTranscripts` newest-first with `limit/skip`; **early-exit** as soon as a page
  contains an already-known id (collect the new ones from that page first). Batch size
  cap 50. Sleep `delayMs` (default 800) between pages.
- `getTranscript(id)` — full detail fetch. The sync engine sleeps `delayMs` **between
  detail fetches too** (listen bug: it only slept in the list loop and could burst-hit
  rate limits on backfill).

Rate limiting — handle **both** transport layers (listen handles both; fireflies-sync
only handles one — copy listen's approach here):
- HTTP 429 → read `retry-after` header (seconds), wait, retry (max 3).
- GraphQL error with `code === "too_many_requests"` (or message matching
  `/rate limit|too many requests|retry after/i`) → parse "retry after <date>" from the
  message, wait until then (fallback 60s), retry (max 3).
- On exhaustion return a typed `rate-limited` error carrying `retryAfterMs` so the UI
  can say "Fireflies rate limit — try again in N minutes".

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

Transcript bodies (sentences array) go to KV, **not** SQL:
`tcw.kv` key `xyz.tinycloud.tinychat/connectors/fireflies/transcript/<source_id>` → JSON
string of the sentences array. KV keys are sent verbatim just like SQL db names, so the
key carries the full `${APP_ID}/connectors/` prefix that the manifest's `connectors/`
grant resolves to. Build keys through `transcriptKvKey()` — the prefix lives in exactly
one place (`CONNECTORS_KV_PREFIX`).

Store API (all take `tcw` as first arg, mirror `threadStore` style):
`ensureSchema`, `getConnection(connectorId)`, `listKnownSourceIds(source)`,
`insertMeeting(normalized)` (skip if `(source, source_id)` already present — app-level
dedup, SELECT-before-INSERT is fine since writes are sequential),
`putTranscriptBody(sourceId, sentences)`, `updateSyncState(...)`,
`purgeConnector(source)` (delete meetings rows + KV transcript keys + state row),
`countMeetings(source)`.

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
  key, { scope: descriptor.secretScope })`. Secret names MUST match
  `/^[A-Z][A-Z0-9_]*$/` — `"API_KEY"` with scope `"fireflies"` complies.
- `getConnectorKey`, `deleteConnectorKey` — same pattern via `.get`/`.delete`.
- All SDK calls return `Result<T, E>` objects (`{ok, data|error}`) — propagate, never throw.
- **First-put 404 defense**: the node-sdk docs note a valid session can still 404 on the
  first `secrets.put` if the dedicated `secrets` space was never hosted. If `put` fails
  with a not-found-shaped error, call `tcw.ensureOwnedSpaceHosted?.("secrets")` if the
  method exists, then retry once. If the method doesn't exist on web-sdk, surface the
  error honestly (no silent fallback — debugging rule).
- `put`/`delete` may trigger the SDK's own permission-escalation modal
  (`requestPermissions`) — that's expected UX, don't suppress it.

**KNOWN BLOCKER (worked around app-side, pending an SDK fix) — secrets reads on
web-sdk 2.5.1.** Reading a secret back is refused with `PERMISSION_DENIED`
("grantRuntimePermissions requires wallet mode with a signer or privateKey"), and
no *static* manifest change can fix it. The write path works, so connect + sync
were never affected; only re-reading the stored key was blocked (which "Sync now"
needs once the in-memory key is gone).

The workaround: `lib/connectors/encryptionGrant.ts` composes the missing
`tinycloud.encryption` / `decrypt` entry once the address is known, and `App.tsx`
appends it to the manifest handed to `createAndSignIn` — sign-in only, since
capabilities are minted from that manifest and a restored session can never
acquire them. It hardcodes the SDK-internal networkId URN format, so it is
sanctioned product surgery, not a design: delete the single
`withEncryptionDecryptGrant(...)` call when the SDK carries the capability itself.
Existing sessions need one sign-out/sign-in to pick the grant up.

Why: node-sdk's `createVaultService` always passes an `encryption` config, and
`usesNetworkEncryption` is just `encryption !== undefined`, so the secrets vault is
always network-encrypted. `NodeSecretsService.ensurePermission` adds, for `get`
only, a `tinycloud.encryption` / `decrypt` entry on the network id
`urn:tinycloud:encryption:<ownerDid>:default`. Nothing grants it: no default tier
includes encryption, and the manifest cannot name it because the URN embeds the
signed-in user's DID, while `expandEncryptionPermissionEntry` rejects any path that
is not a networkId URN (so no wildcard). Escalation is the SDK's only route and it
needs a wallet signer a restored session does not have. Fix belongs in the SDK —
do not work around it in product code.

## 8. Sync engine (`firefliesSync.ts`)

`syncFireflies({ client, store, tcw, onProgress, signal })` → `Promise<Result<SyncResult>>`:

1. `store.ensureSchema(tcw)`; `knownIds = store.listKnownSourceIds("fireflies")`.
2. `client.listNewTranscriptIds({ knownIds, onProgress })` (newest-first early-exit).
3. For each new id (oldest-first so a mid-sync abort leaves a contiguous history tail):
   `client.getTranscript(id)` → normalize → `store.insertMeeting` +
   `store.putTranscriptBody` → sleep `delayMs`. Check `signal?.aborted` between items;
   abort is graceful (everything stored so far stays; state records partial sync).
4. `store.updateSyncState` with `ok`/`error`, `itemCount = countMeetings`, timestamp.
5. Per-item errors: skip the item, record in `SyncResult.errors`, continue the run
   (one bad transcript must not kill the sync); auth/rate-limit errors abort the run
   with the typed error.

The engine imports nothing from React and touches no globals — everything injected, so
e2e drivers run it under bun against the mock upstream + fake tcw.

## 9. UI

### `ConnectorsCard.tsx` (mounted in SettingsPage, near the Data/import card)

- Section title "Connectors", subtitle: "Connect external sources. Synced data is
  stored in your space." (Only the API key in `tcw.secrets` is AES-encrypted;
  SQL/KV rows live in the user's own space but are not encrypted at rest — keep
  copy honest.)
- One row/card per registry entry: icon, name, description.
  - `coming-soon` → greyed, "Coming soon" badge, non-interactive.
  - `available` + disconnected → "Connect" button → opens `ConnectorDialog`.
  - connected → status line ("Last synced 5 min ago · 42 meetings" — relative time,
    absolute on hover), `Sync now` button (spinner + inline progress "Syncing 3/12…"
    while running, driven by `onProgress`), overflow/secondary action "Disconnect".
  - last sync error → subdued error line with the typed message (rate-limit shows
    retry-in time).
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
     secrets (scoped path), never in KV/SQL.
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
