---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Granola meeting-source plumbing: a flag-gated backend pass-through (`GET /api/connectors/granola/v1/notes*`, `GRANOLA_PROXY_ENABLED`, default off) and the client/sync-engine/store plumbing to write `granola` meetings, all dark until `VITE_GRANOLA_CONNECTOR_ENABLED`. Read-side source allowlists now include `granola`. No user-visible change.

Details: TC-3292
