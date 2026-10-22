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

Job records hold no titles, meeting ids, or transcript text. Records older than 30 days are removed by a sweep. The sweep is injectable; scheduling it is not part of this change.

## Coalescing and active runs

Starts for one owner and capability are checked and recorded in a per-owner, in-process lane. At most one run is active per owner and capability.

- A wake that arrives while a run is active attaches. It gets its own job record, mirroring the run's `state`, `code`, and `message`, and returns 202. A run takes at most 20 attached wakes. The 21st gets a 202 with a job record coded `rate_limited` and `retryAfterSec: 60`, and starts nothing.
- Attached wakes do not consume the cooldown or the daily cap.
- A run that has not reported within 30 minutes is settled as `error` with code `unavailable` and released, so it cannot hold the capability.
- Coalescing is per capability. `sync-meetings` and `sync-fireflies` wakes for the same source do not coalesce with each other.
- The lane holds for a single server process only. Multiple instances need the durable ledger with compare-and-set (S4).

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

Cooldown and daily-count state is held in process memory. It resets on restart. A durable ledger is not part of this change.

## Connector gate

`sync-fireflies` requires the Fireflies connector on for the owner. `sync-google` requires the Google connector on. `sync-meetings` requires either one on. When the gate refuses, the job record is coded `connector_off`, with `link` set to the frontend origin and, for a single-source capability, `source`. The route answers 202 like every other verified outcome. The gate runs after grant and request verification.

## Current wiring

Default wiring supplies no concrete grant, record, job, or executor stores. With the flag set to `true` and no stores wired, every well-formed wake returns 202 `accepted` and writes no record. Concrete stores and the sync executor are supplied separately.

The grant route `GET | POST | DELETE /api/exo/v1/grant` is mounted only while the flag is exactly `true`, after session auth and CSRF. It stores grants through the exo store and is separate from the wake route.

Grant activation (`backend/src/portable-delegation.ts`) branches on the verified grant's `policy`. An exo sync grant (`policy: "exo-sync"`) activates only the exact two KV prefixes above with their abilities: exactly two resources, no SQL, no extra ability, no widened prefix. Any other exo shape is refused before any governed write (`beforeNodeWrite`) or node call. Transcript-writer grants keep the existing rules (1 to 4 resources, at most one `sql`/`duckdb`/`hooks`, `MAX_ACTIVATABLE_RESOURCES`), and this change does not alter them.

## Activated grant reach

An activated exo grant reaches the owner's `applications` space through two KV prefixes only: `requests/` (get, list, del) and `jobs/` (get, put, del). Nothing else is activated: no `sql`, no other prefix, no other ability.

The typed accessor (`backend/src/exo/activated-grant.ts`) exposes `requestsGet`, `requestsList`, `requestsRemove`, `jobsGet`, `jobsPut`, and `jobsRemove`. Paths are full keys under the shared prefixes. A path is refused before any KV call when it is not a literal path under its prefix: `..` or encoded traversal, empty or `.` segments, a trailing slash on a key, a bare prefix, or a sibling such as `requestsX` or `jobs-evil`. `requestsList` takes a directory and requires a trailing `/`. Stored values may be raw JSON bytes, a JSON string, or an already-parsed value; `*Get` returns the parsed value, or `undefined` when the key is absent.

Exo sync grants are stored under `delegations/exo-sync/` with `kind: "exo-sync"` and envelope format `tinychat.exo-sync-grant`. Connector grants are stored under `delegations/` with `kind: "transcript-writer"` and envelope format `tinychat.transcript-writer-grant`. On load, the exo store returns null, and logs a warning, for a record with no `kind` (it does not accept unkinded records; only the connector store does, as legacy records) and for a record of another kind. On store, an envelope that parses as JSON with a `format` other than `tinychat.exo-sync-grant` throws before any write. An envelope with no `format` key, or one that is not JSON, is not classified by the store; the route verifies the grant before it reaches the store.

## Onward delegation (follow-up gate)

The grant verifier does not require `remainingRedelegationDepth: 0`, and this change does not make an exo grant non-transferable. A holder of an activated exo grant MAY delegate it onward. Any onward grant reaches only the two prefixes above with their abilities; it carries no meeting content, no encryption keys, and no decrypt capability.

This is a follow-up gate, not a closed control. The SDK cannot yet make a grant non-transferable for a `did:pkh` recipient. Until the SDK supports that, this document makes no claim that onward re-delegation is prevented. Closing the gate is required before exo grants are treated as non-transferable.

`backend/scripts/exo-grant-probe.ts` checks these boundaries against a live node. It runs only when `EXO_PROBE_NODE_URL` is set, is not run in CI, and prints one `PROBE` line per check. It uses an in-memory throwaway owner key, delegates the exo grant to a throwaway backend DID, and removes every key it wrote.
