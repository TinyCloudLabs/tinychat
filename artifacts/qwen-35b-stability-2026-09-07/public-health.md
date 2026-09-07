# Public health for qwen/qwen3.6-35b-a3b

One snapshot collected **2026-09-07 22:12:41–22:12:42 UTC**, before the authenticated stability test. Sources: [RedPill model catalog](https://api.redpill.ai/v1/models) and [model uptime](https://redpill.ai/api/models/qwen/qwen3.6-35b-a3b/uptime). Full response data is preserved in [health-before.json](health-before.json).

**Public telemetry suggests the model is currently usable, with recent improvement, but does not establish stable end-to-end service.** The provided three-day aggregate is **99.2839%**, essentially unchanged from the earlier 21:50 snapshot's **99.2854%**. Its current 22:00 hourly bucket is **99.3789%**, down from the preceding 21:00 bucket's 100%, and remains above the router's 99% health threshold. The current hour is partial; the reporting period ended at `2026-09-07T22:12:26.754160Z`.

- The three-day series contains 73 hourly buckets: 72 numeric values and 1 unknown value. Eight numeric buckets fall below 99%; none fall below 95%.
- Worst reported hour: **95.6404%** at `2026-09-05T17:00:00Z`.
- All of the latest 24 hourly buckets are at least 99%. This is a statement about individual hourly buckets, not a weighted 24-hour success rate.
- Reported first-token latency is **1,300 ms**, with **106.2 tokens/s**. First-token telemetry may include reasoning; the authenticated tests measure visible-content latency separately.

The response lists `phala` (self route) and `near-ai`, but their aggregate, every hourly bucket, latency, and throughput are identical in this snapshot. The API catalog lists only `near-ai`. These must not be counted as independent reliability observations or proof of independent redundant capacity.

The catalog reports **TEE**, **262,144 context tokens**, and **$0.20 input / $1.27 output per million tokens**. Its supported-feature, supported-parameter, and supported-sampling-parameter arrays are empty: tool calling is **unspecified**, not proven unsupported. The metadata also lists image/video input while its description says text-only deployment, so multimodal serving is unverified. No response attestation, tool behavior, or large-context behavior was tested by these public GETs.

The eight sub-99% hourly values are:

| UTC hour | Reported uptime |
|---|---:|
| 2026-09-05T10:00:00Z | 98.3459% |
| 2026-09-05T11:00:00Z | 98.4088% |
| 2026-09-05T13:00:00Z | 96.3964% |
| 2026-09-05T17:00:00Z | 95.6404% |
| 2026-09-05T18:00:00Z | 97.9955% |
| 2026-09-05T19:00:00Z | 97.9847% |
| 2026-09-05T22:00:00Z | 98.9784% |
| 2026-09-05T23:00:00Z | 98.6759% |

Unknown bucket: 2026-09-05T14:00:00Z.
