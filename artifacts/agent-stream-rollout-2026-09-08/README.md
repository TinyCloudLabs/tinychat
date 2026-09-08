# PR 67 rollout readiness — September 8, 2026

The configuration blocker is resolved. Repository Actions variables were written
and read back on September 8 at 15:35 UTC:

| Variable | Value | Rationale |
| --- | ---: | --- |
| `AGENT_STREAM_HEARTBEAT_MS` | `10000` | Pinned ingress delivered 10-second comments across its measured 60-second idle boundary |
| `AGENT_STREAM_TURN_TIMEOUT_MS` | `300000` | Explicit five-minute resource and UX limit; not a provider latency guarantee |
| `AGENT_STREAM_DRAIN_GRACE_MS` | `5000` | Finite terminal cleanup allowance, separate from the turn bound |

These are explicit operator settings, not application defaults. The same values
are in `stream-policy.env`. Repository variables are used because the workflow
reads them at workflow scope. Environment and organization variable scopes were
empty when checked. Setting variables does not deploy or restart a service.

## Completed evidence

All behavior tests concern unchanged implementation commit
`5e6550f52ff5c4075767e103eb3d06e5b0fee17b`. This follow-up adds evidence and rollout
documentation; application source, dependency lockfile, image and workflow logic
remain unchanged.

- [Policy and accounting](accounting/README.md): Bun 1.4.0; 89 maintained policy
  and deployment tests, 14 maintained accounting tests, and ten additional
  actual-route/local-usage/ledger-outbox scenarios passed. The exact selected
  policy passed workflow preflight and env-file/compose forwarding.
- [Transport](transport/README.md): a network-disabled test of the pinned ingress
  image cut off the silent control at 60.2 seconds; 10-second comments traversed
  TLS for 75 seconds with maximum gap 10.006 seconds, one DONE and real HTTP EOF.
  No ingress change is indicated by this evidence.
- [Live providers](providers/README.md): all eight plain/tool contracts passed
  across Kimi K3, GLM 5.3, GLM 5.2, and Qwen 3.6 35B. Usage and finish reasons
  arrived before DONE; DONE was the final data event; HTTP EOF followed. Four
  initial requests returned unclassified 429s and a fifth was interrupted.
  An identical diagnostic then succeeded; the seven remaining requests passed
  with pacing. This establishes sampled protocol compatibility, not an uptime
  guarantee. Successful requests reported total cost USD 0.00373910.
- [Actual Safari 18.6](safari/README.md): nine required local UI cases passed,
  including EOF, broken socket, timeout, Stop, and all four silent phases. Partial
  text persisted, failed receipts/completions stayed absent, activity cleared,
  and the composer accepted another draft. Zero page errors or unhandled
  rejections. An extra mistyped fixture request is retained and explicitly
  excluded from the nine-case count.
- Existing full-suite/build/Linux-image and real authenticated Chrome/TinyCloud
  persistence evidence in the PR remains applicable to the unchanged product
  source. Those passing suites were not repeated for documentation-only changes.

## Runtime and accounting disposition

Bun 1.4.0 is retained. The consumed-POST disconnect regression, real socket
suite, and built Linux image evidence justify the runtime update. Do not run
the backend on the workstation's global Bun 1.3.9.

For this release, retain the existing result-based charging policy. Successfully
returned observed totals are eligible for local usage and ledger enqueue;
active interruptions and write/end exceptions do not invent partial charges.
The new audit confirms both accounting paths agree. This deliberately favors
undercharging over estimating usage: an exception after completed rounds can
discard their recorded usage, and cancellation can avoid recorded credits even
when the provider incurred cost. UI receipts are independently suppressed on
interruption. Changing that behavior would require a separate charging-policy
change. This is the recommended rollout disposition, not a claim of an earlier
maintainer signoff or that every failed reply is free upstream.

## Deployment and remaining live check

The current backend and ingress were independently observed running main
`abdab6c3db7665a3c7f43a3ad4122ca9a31972e0`, with successful Phala run
[34209232597](https://github.com/TinyCloudLabs/tinychat/actions/runs/34209232597).
The matching tags, runtime image IDs, Pages deployment, public health and
sanitized compose structure are recorded in `transport/README.md` and
`transport/deployment-structure.json`. Preserve that backend/ingress pair and
the effective protected configuration as the recovery baseline immediately
before changing production; do not reuse the older `04c63069...` baseline.

The remaining gate is a controlled deployment, including acceptance of the
documented accounting disposition, through the existing Phala workflow followed
by a canary over `https://api.tinycloud.chat`. Dispatching
`deploy-backend-phala.yml` from the PR branch targets the existing production
CVM and affects all backend traffic; it is not an isolated preview deployment.
Merging also triggers the backend workflow and frontend deployment. No production
dispatch, merge, or application restart was performed for this evidence update.

Before dispatch, refresh the PR/main SHA and running images, retain the effective
configuration securely, and verify the three variables still match this report.
After the workflow succeeds, verify its image/build identity and public health,
then run a small sequential synthetic chat success/Stop/recovery check using an
authenticated operator seat and actual Safari. Capture native comment arrival,
DONE and HTTP EOF independently; the product parser cancels at DONE and cannot
alone prove HTTP EOF. Do not use private meeting prompts. Stop the rollout on
transport/protocol failure or repeated provider 429s.

The stronger deterministic transport canary described in `transport/README.md`
also requires an isolated synthetic-provider canary seat routed through the
public ingress. That seat is not provisioned by this PR. Do not replace the
global production provider/tool configuration to force stalls. Until such a
canary runs, four-phase silence and the five-minute deadline are established by
local source/socket/ingress tests, not measured through the live Phala gateway.

This release is prepared for a controlled rollout. It is not yet certified by a
production-path canary, and the historical connection-closing component remains
unproven.
