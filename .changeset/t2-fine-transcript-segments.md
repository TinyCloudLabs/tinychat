---
"@tinychat/frontend": patch
"exo-desktop": patch
---

Preserve short, timed transcript segments from local and hosted engines, including channel identity and honest coarse timing.

The backend hosted transcript GET responses gain additive sentence word times and normalized channel fields. Until the backend is deployed, long Powerful sentences fall back to coarse word-boundary splits.

A 0.7.1 same-revision write can still overwrite a richer transcript body. The next new-client commit repairs it on resync; this is repair, not prevention.
