# Substitute candidates to test — 2026-09-07

The fixed production preference remains **Kimi K3 → GLM 5.3 → GLM 5.2**. This research does not add models to that ladder. It identifies candidates for a bounded authenticated acceptance run.

Public catalog and health checked around **2026-09-07T21:50:49.399Z**; model labels verified by fresh page GETs at 21:51 UTC. [Current API catalog](https://api.redpill.ai/v1/models). All compared entries claim TEE hosting; no response attestation was verified.

| Test order / candidate | USD / million input → output | Context | Page status | API tool claim | Latest hourly uptime / 3-day aggregate | Reason to test |
|---|---:|---:|---|---|---|---|
| 1. [openai/gpt-oss-120b](https://redpill.ai/models/openai/gpt-oss-120b) | $0.15 → $0.60 | 131,072 | No Beta/deprecation label observed | Advertised | [100.000% / 99.803%](https://redpill.ai/api/models/openai/gpt-oss-120b/uptime) | Cheap alternative family; strong reported health. Tinfoil aggregate 99.894%; secretai aggregate 81.046%, so routes differ. |
| 2. [qwen/qwen3.6-35b-a3b](https://redpill.ai/models/qwen/qwen3.6-35b-a3b) | $0.20 → $1.27 | 262,144 | No Beta/deprecation label observed | Unknown (empty metadata) | [100.000% / 99.285%](https://redpill.ai/api/models/qwen/qwen3.6-35b-a3b/uptime) | Cheap 262K model; ~106 tok/s reported. Run tool smoke first. |
| 3. [qwen/qwen3.8-27b](https://redpill.ai/models/qwen/qwen3.8-27b) | $0.30 → $3.00 | 262,144 | Beta | Advertised | [100.000% / 99.782%](https://redpill.ai/api/models/qwen/qwen3.8-27b/uptime) | Newer Qwen with explicit tool/reasoning claims; measure visible text latency. |
| 4. [meta/muse-glimmer-30b](https://redpill.ai/models/meta/muse-glimmer-30b) | $0.30 → $1.10 | 131,072 | Beta | Advertised | [100.000% / 99.518%](https://redpill.ai/api/models/meta/muse-glimmer-30b/uptime) | Another model family; low cost and ~131 tok/s reported. |

The table uses the reported Phala/self route for compactness; the JSON preserves every provider. GPT-OSS has a 131K context window rather than the top three's 1M window, which must be reflected in context budgets. Its existing family-specific synthesis behavior should be exercised with tool results before adoption.

**Also considered:**

- [GLM 5.3 Flash](https://redpill.ai/models/z-ai/glm-5.3-flash): $0.15/$0.50, 1,048,576 context, tools advertised, Beta. Its [latest hour is 100% but three-day aggregate is only 11.356%](https://redpill.ai/api/models/z-ai/glm-5.3-flash/uptime). Attractive test-only/watchlist candidate; the low aggregate cause is unknown.
- [Kimi K2.6](https://redpill.ai/models/moonshotai/kimi-k2.6): $1.09/$4.60, 262,144 context, tools advertised, no Beta/deprecation label observed. [Current-hour uptime 100%, Phala aggregate 99.006%, reported first token 5.445 seconds](https://redpill.ai/api/models/moonshotai/kimi-k2.6/uptime). Lower priority given the fixed Kimi/GLM top three.
- Qwen3-VL-30B-A3B-Instruct: $0.20/$0.70, 128,000 context and tools advertised, but [both reported routes show zero current-hour and aggregate uptime](https://redpill.ai/api/models/qwen/qwen3-vl-30b-a3b-instruct/uptime). Do not prioritize now.

The public metrics are screening evidence, not measured success for our key. The prior benchmark showed that a healthy public bucket can coexist with very slow or failing authenticated requests. Test candidates against Tinychat's configured endpoint, with its actual sampling and synthesis settings: streaming/first-visible-content latency, exact tool argument/result round trip, meeting extraction, and arithmetic. Keep transport, semantic correctness, and strict JSON format scores separate. Lower-context candidates need a corresponding compaction check before production.

Source discrepancies: a cached web view showed older Qwen3.8 pricing; the fresh model page and live API agree on $0.30/$3.00 and $0.05 cache reads. Model pages often describe `tee.redpill.ai`, while the current app uses `api.redpill.ai`; catalog presence and page claims alone do not establish equivalent serving or verification behavior.
