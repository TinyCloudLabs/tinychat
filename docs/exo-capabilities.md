# Exo capabilities (backend mailbox)

Status: behind `EXO_CAPABILITIES_ENABLED`. Off by default. Only the exact value `true` mounts `/api/exo/v1`; empty, unset, or any other value leaves it unmounted.

## Wake route

`POST /api/exo/v1/requests`

Body: exactly `{"owner": "did:pkh:eip155:<chain>:0x<40 hex>", "requestId": "<lowercase UUIDv4>"}`. Extra properties are refused. The owner address is compared and stored in lowercase. Any other owner or request id form is refused with the uniform 409.

| Outcome | Status | Body |
| --- | --- | --- |
| Malformed: body the parser rejects, oversized or extra properties, or owner or request id in the wrong form | 409 | `{"error":"exo_sync_unavailable"}` (identical for all of these) |
| Any outcome after the body parses: unknown owner, no grant, verified, accepted, replayed, coalesced, rate limited, budget, connector off, unavailable | 202 | `{"status":"accepted"}` (identical for all of these) |
| Per-IP limit (120/min), checked before any lookup | 429 | `{"error":"rate_limited"}` with `Retry-After: 60` |

Every outcome after the body parses returns the same 202. The outcome is written to the job record, not the response, so the route does not reveal which check ran or what state the owner is in.

## Request records

Stored at `xyz.tinycloud.tinychat/exo/v1/requests/<capability>/<requestId>`. The record is strict: `{"v":1,"capability":"<capability>"}`. The wake body has no capability, so the route probes the three capability subpaths and requires exactly one valid match.

Capabilities: `sync-meetings`, `sync-fireflies`, `sync-google`.

## Job records

Stored at `xyz.tinycloud.tinychat/exo/v1/jobs/<requestId>`, created put-if-absent (`ifNoneMatch: "*"`). A replayed `requestId` returns the existing job.

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
- `sync-meetings`: no cooldown and no cap.

Cooldown and daily-count state is held in process memory. It resets on restart. A durable ledger is not part of this change.

## Connector gate

`sync-fireflies` requires the Fireflies connector on for the owner. `sync-google` requires the Google connector on. `sync-meetings` requires either one on. When the gate refuses, the job record is coded `connector_off`, with `link` set to the frontend origin and, for a single-source capability, `source`. The route answers 202 like every other verified outcome. The gate runs after grant and request verification.

## Current wiring

Default wiring supplies no concrete grant, record, job, or executor stores. With the flag set to `true` and no stores wired, every well-formed wake returns 202 `accepted` and writes no record. Concrete stores and the sync executor are supplied separately.

Grant activation (`backend/src/portable-delegation.ts`) rejects multi-resource grants today. This change does not alter activation.
