# Exo capabilities (backend mailbox)

Status: behind `EXO_CAPABILITIES_ENABLED`. Off by default. Only the exact value `true` mounts `/api/exo/v1`; empty, unset, or any other value leaves it unmounted.

## Wake route

`POST /api/exo/v1/requests`

Body: exactly `{"owner": "<0x address>", "requestId": "<id>"}`. Extra properties are refused.

| Outcome | Status | Body |
| --- | --- | --- |
| Accepted (new or replayed job) | 202 | `{"jobId","state","code","statusKey"}` |
| Any refusal before verification: malformed or oversized body, unknown owner, no or expired grant, missing or invalid request record | 409 | `{"error":"exo_sync_unavailable"}` (identical for all of these) |
| Per-IP limit (120/min) or per-owner limit (30/min) | 429 | `{"error":"rate_limited"}` with `Retry-After` |

Every 409 is the same response by design, so the route does not reveal which check failed.

## Request records

Stored at `xyz.tinycloud.tinychat/exo/v1/requests/<capability>/<requestId>`. The record is strict: `{"v":1,"capability":"<capability>"}`. The wake body has no capability, so the route probes the three capability subpaths and requires exactly one valid match.

Capabilities: `sync-meetings`, `sync-fireflies`, `sync-google`.

## Job records

Stored at `xyz.tinycloud.tinychat/exo/v1/jobs/<requestId>`, created put-if-absent (`ifNoneMatch: "*"`). A replayed `requestId` returns the existing job.

```
{v:1, jobId, capability, state: pending|running|done|error, message?, code?, createdAt, updatedAt}
```

Job records hold no titles, meeting ids, or transcript text. Records older than 30 days are removed by a sweep. The sweep is injectable; scheduling it is not part of this change.

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

`sync-fireflies` and `sync-google` require their connector to be on for the owner. `sync-meetings` has no connector gate.

## Current wiring

Default wiring supplies no concrete grant, record, job, or executor stores. With the flag set to `true` and no stores wired, every wake returns the uniform 409. Concrete stores and the sync executor are supplied separately.

Grant activation (`backend/src/portable-delegation.ts`) rejects multi-resource grants today. This change does not alter activation.
