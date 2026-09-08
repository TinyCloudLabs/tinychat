# TinyChat model ladder evaluation — September 7, 2026

The current six-model order should change. For balanced cost and response time, use **GLM 5.3 → Kimi K3** as the provisional automatic selection order. Kimi was the strongest operational performer in this small run; **Kimi K3 → GLM 5.3** is the alternative when completion reliability takes priority over price. Neither order is a claim of sustained reliability.

Keep DeepSeek 0731 out of automatic selection while it repeatedly returns 429. GLM 5.2, Qwen 3.6 27B, and Gemma 4 31B need targeted latency/recovery checks before serving as automatic fallbacks. This evaluates current serving behavior with TinyChat-like settings, not intrinsic model quality. Product code, the PR, deployments, and historical release evidence were not changed.

## Live results

Authenticated synthetic requests ran from **21:21:09 to 21:27:05 UTC** through `https://api.redpill.ai/v1/chat/completions`. There were **23 attempted requests**, of which **14 completed within the 60-second limit**. Scheduled requests skipped after the circuit breaker are not counted as failures or attempts.

| Model | Completed / attempted | Short reply: first visible text | Meeting extraction | Budget calculation | Tool call + result |
| --- | ---: | --- | --- | --- | --- |
| GLM 5.3 | 5 / 6 | 2.37 s; 0.97 s | Core facts correct; 25.17 s total | HTTP 429 | Correct call and exact result; 3.10 s combined |
| DeepSeek V4 Flash 0731 | 0 / 2 | HTTP 429 | HTTP 429 | Not attempted | Not attempted |
| GLM 5.2 | 1 / 3 | 58.58 s; second sample skipped | 60 s timeout | 60 s timeout | Not attempted |
| Kimi K3 | 6 / 6 | 2.48 s; 2.51 s | All requested facts; 19.86 s total | Exact 9/9 fields; 22.02 s total | Correct call and exact result; 9.31 s combined |
| Qwen 3.6 27B | 1 / 3 | 7.74 s; second sample skipped | 60 s timeout | 60 s timeout | Not attempted |
| Gemma 4 31B | 1 / 3 | 1.34 s; second sample skipped | 60 s timeout | 60 s timeout | Not attempted |

Both GLM 5.3 and Kimi wrapped the meeting answer and final tool result in Markdown JSON fences despite the raw-JSON instruction. The original strict parser correctly records those format failures. Independent review confirmed the underlying tool values, including the unpredictable proof nonce, were exact for both models. Their tool round trips succeeded semantically. Kimi's meeting answer included all requested facts; GLM 5.3 correctly marked the budget unapproved but omitted budget approval from its separate unresolved-items list. No incorrect factual answer was observed in the completed fixtures; most models did not complete those fixtures, so their accuracy remains unmeasured.

The timeout modes differ. GLM 5.2 and Gemma returned HTTP 200 headers but no SSE frames on the meeting task before the deadline. Qwen streamed substantial hidden reasoning but no visible answer within the limit. These are user-visible latency failures, not evidence of incorrect answers. Prior historical tool passes for those models remain valid historical observations; this run did not repeat their tool checks after two transport/deadline failures.

## Price and provider telemetry

Public catalog snapshot: **21:17:38 UTC**. Uptime snapshot: **21:18:10 UTC**. Price is USD per million input/output tokens. Uptime below is the reported Phala provider record; other provider records are retained in `metadata.json`.

| Model | Input / output price | Context tokens | Current partial-hour uptime | Three-day uptime |
| --- | ---: | ---: | ---: | ---: |
| GLM 5.3 | $1.40 / $4.40 | 1,048,576 | 99.978% | 99.799% |
| DeepSeek 0731 | $0.44 / $1.32 | 1,048,576 | 62.153% | 94.192% |
| GLM 5.2 | $1.26 / $3.00 | 1,048,576 | 99.869% | 99.923% |
| Kimi K3 | $3.00 / $15.00 | 1,048,576 | 100% | 99.924% |
| Qwen 3.6 27B | $0.32 / $2.70 | 262,144 | 99.394% | 98.904% |
| Gemma 4 31B | $0.15 / $0.46 | 262,144 | 95.238% | 98.701% |

Kimi's output rate is about 3.4 times GLM 5.3's, and its input rate is about 2.1 times. Their tool round-trip latency also differed in this run. That supports keeping GLM 5.3 first when balancing cost and speed, while acknowledging Kimi's stronger completion results here. Token prices alone do not measure completed-task cost: models produce different quantities of reasoning and answer tokens.

Sources: [RedPill model catalog](https://api.redpill.ai/v1/models), [pricing](https://redpill.ai/pricing), and each exact model's `https://redpill.ai/api/models/{model}/uptime` endpoint, preserved in `metadata.json`. Provider uptime is not this credential's request-success rate. GLM 5.3's apparently healthy public data coexisted with an authenticated 429 in this run; the current router's public uptime threshold does not capture all real serving failures or stalls.

## Implications for the router

- Separate automatic routing eligibility from the complete/manual model catalog. A cheap or interesting model need not be an automatic fallback.
- Use current health to filter a tested automatic order; do not interpret a good hourly percentage as proof of acceptable latency or per-key availability.
- Preserve the existing per-chat model choice and captured turn model. Reordering the new-chat ladder does not solve failures later in a pinned chat. A visible retry or switch is a separate product decision; do not silently change models during a turn.
- Before production, repeat the matched chat/tool checks in another time window for the intended automatic candidates, and establish a recovery criterion for excluded candidates. Investigate Qwen's default reasoning latency separately from GLM/Gemma empty-stream stalls. No longer-running background test was started.

This comparison does not resolve the PR's separate backend-before-frontend deployment ordering or production Eliza compatibility checks.

## Method and evidence

The probe used Bun 1.3.9 and PR head `7a723c3311ff9573c60719b1363e1a2428f0bfc1`. Six scheduled request types per model: two short streamed replies, a meeting commitment/uncertainty fixture, grounded token-cost arithmetic, one tool call, and its result synthesis. Tasks ran in rotated model order, with at most two models in flight and no simultaneous requests to one model. Tool synthesis depends on a valid first call. Stop after two model transport/deadline failures; respect `Retry-After`; no immediate retries. Every request had an 8,192-output-token cap and a 60-second total deadline. Native sampling/reasoning defaults were retained; tool synthesis used `reasoning_effort: low`, matching TinyChat's synthesis setting. The cap and deadline are benchmark limits, unlike TinyChat's uncapped normal relay payload.

All prompts and returned data are synthetic. The local key was read through the process environment and is absent from these artifacts. Some response usage records reported costs totaling approximately $0.04884; that is not a complete billing total because aborted requests may incur usage without returning a final usage record.

These few calls support a provisional operational choice, not a statistically reliable availability estimate, general quality ranking, or permanent exclusion. No large-context, multilingual, coding, response-attestation, live Eliza, or full application test was performed in this comparison. The tool lookup is a local synthetic result with a fresh nonce. JSON formatting compliance is kept distinct from semantic correctness.

- [Exact method and prompts](method.json)
- [Reproducible explicit probe](probe.ts)
- [Full request/response measurements](results.json)
- [Append-only measurements from the run](results.jsonl)
- [Price, context, and all reported provider telemetry](metadata.json)

Re-running `probe.ts` performs paid inference and overwrites this directory's run outputs. Preserve this evidence in a separate directory before an explicit new run.
