# Live selected-provider contract evidence — September 8, 2026

All eight required short synthetic contracts passed: one complete plain answer and one well-formed tool call for each model in `packages/core/src/chatModels.ts` at PR #67 head `5e6550f52ff5c4075767e103eb3d06e5b0fee17b`. Each stream supplied valid token usage before `[DONE]`, emitted its finish reason before `[DONE]`, made `[DONE]` its final data event, and reached HTTP EOF. No tool was executed.

| Selected model | Plain answer | Tool call | Usage before DONE |
| --- | ---: | ---: | --- |
| `moonshotai/kimi-k3` | Pass, 3.877s | Pass, 4.707s | Both |
| `z-ai/glm-5.3` | Pass, 3.692s | Pass, 1.524s | Both |
| `z-ai/glm-5.2` | Pass, 36.931s | Pass, 3.684s | Both |
| `qwen/qwen3.6-35b-a3b` | Pass, 2.316s | Pass, 3.540s | Both |

The initial run received four HTTP 429 responses (Kimi plain/tool and GLM 5.3 plain/tool). A fifth request, GLM 5.2 plain, was terminated while in flight when that run was stopped; no response status or usage was observed for it. The initial probe discarded error bodies and did not retain Retry-After, so those responses cannot be classified beyond HTTP 429.

A separately authorized diagnostic repeated the same Kimi plain request with the same credential and parameters and succeeded. The seven missing contracts then succeeded sequentially, with at least 15 seconds between requests. There were 13 inference attempts total: four HTTP 429 responses, one interrupted request, and eight successes. There were no automatic retries. The failure-to-success change supports a transient condition; it does not establish whether throttling came from the account, gateway, or model provider.

The hardened probe now stops immediately on HTTP 401, 402, 403, or 429 and captures a fixed error classification plus a parsed Retry-After delay, without retaining raw provider error bodies. [RedPill documentation](https://docs.redpill.ai/developers/guides/error-handling) describes 429 as a rate limit; the unretained initial bodies prevent confirming a more specific cause here.

Requests used Bun 1.4.0, the existing RedPill endpoint, `stream: true`, `stream_options: { include_usage: true }`, default sampling, and no reasoning override. Timeout was 60 seconds per request. The token cap was 256 except Qwen, which used 512 because the prior short fixture had consumed 228 tokens including reasoning. The cap bounds the probe only; it changes no runtime setting.

The provider-reported cost across the eight successful responses was USD 0.00373910. No usage was observed for the four rejected requests or the interrupted request; this is not an account billing reconciliation.

The configured RedPill credential values in the existing TinyChat backend `.env`, root `.env.prod`, and root `.env` matched in memory; there was no exported shell override. No values or hashes were saved. The actual deployed Phala/GitHub credential was not compared, so local equality does not prove deployed equality.

Evidence: `results.json` / `results.jsonl` describe the stopped first run; `diagnostic-results.json` contains the successful Kimi plain request; `completion-results.json` contains the other seven successes; `summary.json` combines the contract evidence. Corresponding method files preserve each run’s settings. `probe.ts` contains the reproducible bounded check. Scoped ESLint and `git diff --check` pass.

To rerun after provisioning `REDPILL_API_KEY` securely, use Bun 1.4.0:

```sh
bun artifacts/agent-stream-rollout-2026-09-08/providers/probe.ts
```

A fresh run writes method/results beside the probe; preserve this recorded evidence before rerunning. Default mode makes at most eight sequential requests with 15-second pauses and no automatic retries. `--diagnostic` makes one Kimi plain request; `--complete-missing` makes the other seven requests.

This closes the observed usage-before-DONE and synthetic tool-shape check for the four selected model IDs. It does not establish sustained provider availability, production transport heartbeat delivery, long-turn behavior, real tool authorization, browser recovery, accounting disposition, or per-response attestation. GLM 5.2’s plain request took 36.931 seconds, which reinforces the need for downstream heartbeat delivery while an upstream round is quiet.
