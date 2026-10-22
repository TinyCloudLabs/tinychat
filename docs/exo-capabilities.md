# Exo capabilities (backend mailbox)

Status: behind `EXO_CAPABILITIES_ENABLED`. Off by default. Only the exact value `true` mounts `/api/exo/v1`; empty, unset, or any other value leaves it unmounted.

## Wake route

`POST /api/exo/v1/requests`

Body: exactly `{"owner": "did:pkh:eip155:<chain>:0x<40 hex>", "requestId": "<lowercase UUIDv4>"}`. Extra properties are refused. The owner address is compared and stored in lowercase. Any other owner or request id form is refused with the uniform 409.

| Outcome | Status | Body |
| --- | --- | --- |
| Accepted (new or replayed job) | 202 | `{"jobId","state","code","statusKey"}` |
| Any refusal before verification: malformed or oversized body, unknown owner, no or expired grant, missing or invalid request record | 409 | `{"error":"exo_sync_unavailable"}` (identical for all of these) |
| Per-IP limit (120/min), per-owner limit (30/min), or attach limit (more than 20 wakes on one active run) | 429 | `{"error":"rate_limited"}` with `Retry-After` (60 s for the attach limit) |

Every pre-verification refusal returns the same 409, so the route does not reveal which check failed. The connector gate under "Connector gate" is the only exception, and it runs after verification.

## Request records

Stored at `xyz.tinycloud.tinychat/exo/v1/requests/<capability>/<requestId>`. The record is strict: `{"v":1,"capability":"<capability>"}`. The wake body has no capability, so the route probes the three capability subpaths and requires exactly one valid match.

Capabilities: `sync-meetings`, `sync-fireflies`, `sync-google`.

## Job records

Stored at `xyz.tinycloud.tinychat/exo/v1/jobs/<requestId>`, created put-if-absent (`ifNoneMatch: "*"`). A replayed `requestId` returns the existing job.

```
{v:1, jobId, capability, state: pending|running|done|error, code, message, createdAt, updatedAt}
```

`code` is one of `accepted`, `running`, `done`, `unavailable`. `message` is the fixed text for that code. `jobId` equals the request id.

Job records hold no titles, meeting ids, or transcript text. Records older than 30 days are removed by a sweep. The sweep is injectable; scheduling it is not part of this change.

## Coalescing and active runs

Starts for one owner and capability are checked and recorded in a per-owner, in-process lane. At most one run is active per owner and capability.

- A wake that arrives while a run is active attaches. It gets its own job record, mirroring the run's `state`, `code`, and `message`, and returns 202. A run takes at most 20 attached wakes. The 21st gets 429 `rate_limited` with `Retry-After: 60`.
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

`sync-fireflies` requires the Fireflies connector on for the owner. `sync-google` requires the Google connector on. `sync-meetings` requires either one on. A refusal returns 409 `connector_off` with the source and frontend link. This gate runs after grant and request verification, so it is the one 409 that differs from the uniform pre-verification 409.

## Current wiring

Default wiring supplies no concrete grant, record, job, or executor stores. With the flag set to `true` and no stores wired, every wake returns the uniform 409. Concrete stores and the sync executor are supplied separately.

Grant activation (`backend/src/portable-delegation.ts`) rejects multi-resource grants today. This change does not alter activation.
