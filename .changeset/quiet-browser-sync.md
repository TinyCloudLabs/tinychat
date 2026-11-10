---
"@tinychat/frontend": patch
---

Stop local replica sync for a session after the SDK rejects its grant as non-compact UCAN; close the controller and avoid retries, while preserving other replica errors. Avoid querying missing connector-state tables during read-only settings checks on fresh spaces.
