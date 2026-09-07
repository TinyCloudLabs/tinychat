# Qwen 3.6 35B A3B stability check

**Verdict: successful short-run serving; promising fallback candidate, not proven long-term stability.** `qwen/qwen3.6-35b-a3b` completed all 12 authenticated requests without HTTP errors or timeouts. Tool execution and arithmetic were consistent. Meeting extraction missed one committed action on one of two attempts, so its answer quality was not completely consistent.

The locked ladder remains **Kimi K3 → GLM 5.3 → GLM 5.2**. No model was added, and no product code, PR, or deployment was changed by this probe.

## Observed results

Run: **2026-09-07, 22:12:48–22:14:48 UTC**, using the app's `https://api.redpill.ai/v1/chat/completions` route. All responses identified the requested exact model. Requests were sequential, in two waves separated by 30 seconds; this was not a load test.

| Check | Result | Total completion time |
| --- | --- | --- |
| Short streamed replies | 4/4 exact markers | 1.24–2.65 seconds |
| Tool lookup + result synthesis | 2/2 semantically correct round trips | 5.18 and 2.02 seconds for both requests combined |
| Grounded workload-cost arithmetic | 2/2; all nine fields exact | 15.75 and 20.09 seconds |
| Meeting action/uncertainty extraction | 1/2 complete; one action omission | 20.41 and 16.89 seconds |

In the first meeting response, Leo's explicit commitment to finish SSO verification was omitted from the action list. The response correctly noted that his completion date was unknown, but that did not preserve his owner/action commitment. It also omitted budget approval from the separate unresolved list while correctly setting `budget_approved: false`. The second response retained both committed actions and all expected unresolved items.

Both tool rounds made the correct `lookup_meeting` call with the exact meeting ID, then reproduced all four returned fields including a newly generated unpredictable decision-code nonce. Both final tool answers used Markdown JSON fences despite the raw-JSON instruction. The strict parser therefore records format failures; independent semantic review confirmed the tool results were correct. The raw scores remain unchanged in the evidence.

The observed response usage records sum to approximately **$0.0193**. The public catalog price is **$0.20 input / $1.27 output per million tokens**, with **262,144 context tokens**. This is a smaller context window than the locked top three. TEE is a catalog claim here; response attestation was not tested.

## Public history

The single pre-run [uptime snapshot](https://redpill.ai/api/models/qwen/qwen3.6-35b-a3b/uptime), collected at 22:12 UTC, reported:

- Three-day aggregate: **99.2839%**.
- Current partial hour: **99.3789%**; preceding hour: **100%**.
- Latest 24 hourly buckets: all at least 99%.
- Eight older buckets below 99%, all on September 5; the worst was **95.6404%**.

Phala and NEAR AI entries contained identical telemetry, so they are not independent reliability observations. These upstream metrics and the 12 successful requests support current usability, but do not establish sustained availability for our credential, concurrent workloads, or peak hours. The catalog's empty tool-capability arrays did not prevent the two tested tool round trips from working.

## Interpretation and limits

This model is worth considering as a cheaper fourth fallback or optional choice after the fixed top three. Its two-minute serving result is encouraging, and it avoided the long stalls observed for the other Qwen candidate earlier. Different time windows and small samples do not establish a general ranking. The action-extraction omission is a reason to retain Kimi as the primary choice and broaden factual-extraction evaluation before adoption.

The probe retained native sampling/reasoning defaults and used `reasoning_effort: low` for tool synthesis, matching TinyChat's synthesis setting. It imposed an 8,192-output-token cap and a 60-second total request deadline. All requests completed within those limits. The tool was a synthetic local lookup, not a live Eliza call. No full application, large-context, multilingual, or burst test was performed. The 30-second gap creates two brief waves, not independent observations over days.

Instrumentation note: `firstContentMs` measures the first content chunk and can include whitespace-only chunks. The table uses full completion durations rather than claiming time to first meaningful visible text. Hidden reasoning text was not retained, only its character count.

- [Method and exact prompts](method.json)
- [Raw request/response results](results.json)
- [Append-only run log](results.jsonl)
- [Reproducible explicit probe](probe.ts)
- [Public catalog and uptime snapshot](health-before.json)
- [Public-health analysis](public-health.md)

The API credential was supplied through the process environment and is absent from these files. Re-running the explicit probe performs paid inference and overwrites its run outputs; copy it into a separate directory to preserve this evidence.
