---
"@tinychat/backend": patch
---

Add canonical RFC 9562 UUID v1–8 request IDs to backend HTTP responses and explicitly classified first-party ptx-dev/ptx-batch calls, with v4 replacement, a typed replacement flag, redirect isolation and request-scoped console/stream redaction. `REQUEST_ID_FIRST_PARTY_ORIGINS` independently controls request-ID forwarding and defaults to deny. Preserve unscoped stream write callbacks and the independent Private transcription correlation-ID header and error contract. [TC-959](https://linear.app/tinycloud-labs/issue/TC-959).

Isolate the shared transcript delivery worker from initiating HTTP contexts and restore only each volatile queue item's own request ID. Recovery, retries and sweeps without a retained origin send no request ID; delivery state remains unchanged, with an explicit restart/retry correlation gap. Keep payload-safe diagnostics in both attributed item work and the detached shared lifecycle.
