# Exo capabilities (backend mailbox)

Status: behind `EXO_CAPABILITIES_ENABLED`. Off by default. Only the exact value `true` mounts `/api/exo/v1`; empty, unset, or any other value leaves it unmounted.

## Wake route

`POST /api/exo/v1/requests`

Body: exactly `{"owner": "did:pkh:eip155:<chain>:0x<40 hex>", "requestId": "<lowercase UUIDv4>"}`. Extra properties are refused. The owner address is compared and stored in lowercase. Any other owner or request id form is refused with the uniform 409.

| Outcome | Status | Body |
| --- | --- | --- |
| Malformed: body the parser rejects, oversized or extra properties, or owner or request id in the wrong form | 409 | `{"error":"exo_sync_unavailable"}` (identical for all of these) |
| Any outcome after the body parses: unknown owner, no grant, verified, accepted, replayed, coalesced, rate limited, budget, connector off, unavailable; or an internal error at any step | 202 | `{"status":"accepted"}` (identical for all of these) |

The wake reply is intentionally identical for all outcomes, so the reply carries no information about stored requests; the job record holds every state.

## Wake intake

The route answers 202 once the body parses, before any store read. It never answers 429. Verification, the owner budget, and the job write run afterwards in an in-process queue.

- Pending work is capped globally (256) and per owner (16). Work is deduped on (owner, request id).
- Owners are served round-robin, with one verification in flight per owner, so one owner's wakes do not delay another's.
- When a cap is full, a random pending entry is dropped and the newcomer is kept. A dropped wake gets no job record; its sender still sees the same 202.
- The queue is in-process. A restart drops pending wakes. A sender that needs the wake handled re-sends it; a re-sent id creates a job only if none exists.

Owner budget: a wake that creates a new job record spends one unit of a fixed-window budget keyed on the verified owner (30 per minute). A replay spends nothing. A refused wake records a job coded `rate_limited` with `retryAfterSec: 60`; it is consumed like any other first job, so a retry needs a new request id.

## Request records

Stored at `xyz.tinycloud.tinychat/exo/v1/requests/<capability>/<requestId>`. The record is strict: `{"v":1,"capability":"<capability>"}`. The wake body has no capability, so the route reads the three capability subpaths and requires exactly one valid match.

After the job record is created, the request record is deleted through the `requests.remove` port, best effort. The default port fails closed, so the delete fails there and is logged. A failed delete does not fail the job; the request record stays, and a replay reaches the replay branch, which spends nothing and starts nothing.

Capabilities: `sync-meetings`, `sync-fireflies`, `sync-google`.

## Job records

Stored at `xyz.tinycloud.tinychat/exo/v1/jobs/<requestId>`, created put-if-absent (`ifNoneMatch: "*"`). A replayed `requestId` does not return the job: once its request record is consumed, the replay fails verification and the existing job is left as it was.

```
{v:1, jobId, capability, state: pending|running|done|error, code, message, createdAt, updatedAt}
```

`code` is one of `accepted`, `running`, `done`, `unavailable`, `connector_off`, `needs_renewal`, `needs_reconnect`, `storage_full`, `rate_limited`, `budget_exhausted`. `message` is the fixed text for that code. `jobId` equals the request id. `link` (`connector_off`), `source` (`connector_off` on a single-source capability), and `retryAfterSec` (`rate_limited`, `budget_exhausted`) are optional.

Records older than 30 days are removed by the hourly retention sweep (see Retention sweep).

## Coalescing and active runs

Starts for one owner and capability are checked and recorded in the durable ledger (see Durable state). At most one run is active per owner and capability.

- A wake that arrives while a run is active attaches. It gets its own job record, mirroring the run's `state`, `code`, and `message`, and returns 202. A run takes at most 20 attached wakes. The 21st gets a 202 with a job record coded `rate_limited` and `retryAfterSec: 60`, and starts nothing.
- Attached wakes do not consume the cooldown or the daily cap.
- A run that has not reported within 30 minutes is settled as `error` with code `unavailable` and released, so it cannot hold the capability.
- Coalescing is per capability. `sync-meetings` and `sync-fireflies` wakes for the same source do not coalesce with each other.
- Starts are arbitrated by compare-and-set on the durable ledger. This is verified in one process and across a restart. Arbitration across several server instances relies on the node's conditional writes; it has not been run across OS processes.

## Grant shape

The grant verifier (`backend/src/delegation-verify.ts`) accepts one additional shape, used only by the Exo policy:

- kv `get`, `list`, `del` on `…/exo/v1/requests/`
- kv `get`, `put`, `del` on `…/exo/v1/jobs/`

The prefixes are exact. Any other ability, prefix, space, or resource (including `sql`) is refused. Connector grants do not satisfy the Exo policy, and Exo grants do not satisfy the connector policy.

## Cooldowns and caps

Per capability, from the D9 limits:

- `sync-fireflies`: 1 h between starts; 6 h when a Fireflies webhook is present; cap 150 starts per UTC day.
- `sync-google`: 30 min between starts; cap 300 per UTC day.
- `sync-meetings`: no cooldown and no daily cap. Its wakes still spend the per-owner wake budget (see Wake intake).

Cooldown and daily-count state is stored in the durable ledger (see Durable state), so it survives a restart.

## Connector gate

`sync-fireflies` requires the Fireflies connector on for the owner. `sync-google` requires the Google connector on. `sync-meetings` requires either one on. When the gate refuses, the job record is coded `connector_off`, with `link` set to the frontend origin and, for a single-source capability, `source`. The route answers 202 like every other verified outcome. The gate runs after grant and request verification.

## Current wiring

With the flag set to `true`, the wake route's ports come from `createExoStorePorts` (`backend/src/exo/stores.ts`), built in `backend/src/index.ts`. They use the owner grant opener, the backend KV, the webhook token service, the connector control store, and the grant-holder index. No sync executor is registered yet, so a verified wake settles as `error` with code `unavailable`. `createUnwiredExoPorts` (`backend/src/exo/default-ports.ts`) is the fail-closed fixture used by the route tests; production does not mount it.

The grant route `GET | POST | DELETE /api/exo/v1/grant` is mounted only while the flag is exactly `true`, after session auth and CSRF. It stores grants through the exo store and is separate from the wake route.

Grant activation (`backend/src/portable-delegation.ts`) branches on the verified grant's `policy`. An exo sync grant (`policy: "exo-sync"`) activates only the exact two KV prefixes above with their abilities: exactly two resources, no SQL, no extra ability, no widened prefix. Any other exo shape is refused before any governed write (`beforeNodeWrite`) or node call. Transcript-writer grants keep the existing rules (1 to 4 resources, at most one `sql`/`duckdb`/`hooks`, `MAX_ACTIVATABLE_RESOURCES`), and this change does not alter them.

## Durable state

With the flag on, two kinds of record live in the backend KV space, keyed by lowercased owner:

- `ledger/<owner>/<capability>`: cooldown, daily count, and the active run for one capability.
- `source-lock/<owner>/<source>`: one lock per connector source.

Ledger writes are compare-and-set: a create uses `ifNoneMatch`, an update uses `ifMatch` on the version it read. A start that loses a race is refused with `rate_limited`. Ledger entries are never deleted.

A start takes the locks for its capability's sources in `SOURCES_BY_CAPABILITY` order. If any lock is refused, the locks already taken are released. A lock held for more than 30 minutes (`ACTIVE_RUN_TTL_MS`) can be taken over, so a crashed run cannot block a source forever.

- Taking the two locks of `sync-meetings` is not atomic across keys. A crash between the two leaves one lock until its TTL.
- `sync-meetings` and a single-source wake on the same source can both be refused while they contend. Neither runs twice.
- A single-source wake on a source that `sync-meetings` holds is refused with `rate_limited`. It is not attached.

Cooldowns and active runs survive a restart, because each start reads the ledger from KV. The compare-and-set behavior was checked in one process and across a restart by the CAS check script in `backend/scripts/`, which needs the node URL in `EXO_PROBE_NODE_URL` and a live node.

## Shutdown drain

On SIGTERM, queued wakes drain for up to 30 seconds (`WAKE_DRAIN_TIMEOUT_MS`) before the process exits. If the drain times out, the process exits with status 1.

## Retention sweep

Started at startup only when the flag is on. One pass runs per hour (`EXO_RETENTION_SWEEP_INTERVAL_MS`). Passes never overlap, and the interval is `unref()`'d.

Each pass lists the backend-space job mirrors and removes each one older than 30 days (`EXO_JOB_RETENTION_MS`):

- With an active owner grant, the job store removes the mirror first, then the owner's record.
- With no active grant, only the mirror is deleted. The owner's record stays in the owner's space, which the backend cannot reach without a grant.

A failed removal is counted as `failed` and retried on the next pass.

## Teardown

Revoking the exo grant, revoking a transcript delegation, and disconnecting calendar autojoin clear the owner's Exo state. Disconnecting a connector source clears that source's state (see below).

- `DELETE /api/exo/v1/grant`: `backend/src/routes/exo-grant.ts`.
- Transcript delegation `DELETE`: `backend/src/routes/delegations.ts`.
- Calendar autojoin disconnect: `backend/src/services/calendar-autojoin-connection.ts`. It clears before any other change.
- Connector teardown for one source: `backend/src/services/connector-teardown.ts`, step 5.

Owner teardown (`clearExoOwnerState`, `backend/src/exo/teardown.ts`) runs in this order:

1. Owner-space requests and jobs, through the active grant.
2. Backend-space mirror jobs and the owner's ledger rows.
3. The grant record, removed by the caller last.

Every step is idempotent, so a retry after a partial failure finishes the work. A live grant that cannot be activated refuses the teardown until it expires: the routes return 503, and calendar autojoin disconnect fails without changes. After expiry, owner-space rows are left in place, because nothing can reach them.

Source teardown (`clearExoSourceState`) deletes the ledger rows of capabilities that read only that source. It does not touch the grant, which is account-level, or the source locks, which expire on their TTL.

Client-side sign-out does not call these routes.

## Grant holder index

Before a wake opens an owner's grant, the grant-holder index is checked (`backend/src/exo/stores.ts`, `backend/src/exo/grant-holders.ts`). An owner in the index is confirmed by opening the stored grant. An owner not in the index triggers at most one store listing per 5 seconds (`GRANT_HOLDER_REFRESH_MS`); concurrent checks share that listing, and a check inside the window reports no grant without reading the store. So a grant written by another process is seen by the first wake for that owner at least 5 seconds after the last listing. If the listing fails, the owner is reported as holding no grant.

## Activated grant reach

An activated exo grant reaches the owner's `applications` space through two KV prefixes only: `requests/` (get, list, del) and `jobs/` (get, put, del). Nothing else is activated: no `sql`, no other prefix, no other ability.

The typed accessor (`backend/src/exo/activated-grant.ts`) exposes `requestsGet`, `requestsList`, `requestsRemove`, `jobsGet`, `jobsPut`, and `jobsRemove`. Paths are full keys under the shared prefixes. A path is refused before any KV call when it is not a literal path under its prefix: `..` or encoded traversal, empty or `.` segments, a trailing slash on a key, a bare prefix, or a sibling such as `requestsX` or `jobs-evil`. Keys use only `A-Za-z0-9._/-`, at most 512 characters; control, space, non-ASCII, and lookalike characters are refused. `requestsList` takes a directory and requires a trailing `/`. Stored values may be raw JSON bytes, a JSON string, or an already-parsed value. Stored values over 4 KiB, a leading byte order mark, and bytes that are not strict UTF-8 are refused. A stored JSON `null` is absent. `*Get` returns the parsed value, or `undefined` when the key is absent. The owner space builder (`ownerApplicationsSpaceUri`) refuses a chain id that is not a positive safe integer and an owner address that fails checksum validation.

Exo sync grants are stored under `delegations/exo-sync/` with `kind: "exo-sync"` and envelope format `tinychat.exo-sync-grant`. Connector grants are stored under `delegations/` with `kind: "transcript-writer"` and envelope format `tinychat.transcript-writer-grant`. On load, the exo store returns null, and logs a warning, for a record with no `kind` (it does not accept unkinded records; only the connector store does, as legacy records) and for a record of another kind. On store, the exo store accepts only a JSON object whose `format` is exactly `tinychat.exo-sync-grant`; it throws before any write for a non-JSON envelope, a non-object, or an envelope with a missing or different `format`. The route verifies the grant before it reaches the store.

## Onward delegation (follow-up gate)

The grant verifier does not require `remainingRedelegationDepth: 0`, and this change does not make an exo grant non-transferable. A holder of an activated exo grant MAY delegate it onward. Any onward grant reaches only the two prefixes above with their abilities; it carries no meeting content, no encryption keys, and no decrypt capability.

This is a follow-up gate, not a closed control. The SDK cannot yet make a grant non-transferable for a `did:pkh` recipient. Until the SDK supports that, this document makes no claim that onward re-delegation is prevented. Closing the gate is required before exo grants are treated as non-transferable.

`backend/scripts/exo-grant-probe.ts` checks these boundaries against a live node. It runs only when `EXO_PROBE_NODE_URL` is set, is not run in CI, and prints one `PROBE` line per check. It uses an in-memory throwaway owner key, delegates the exo grant to a throwaway backend DID, and removes every key it wrote.
