---
"@tinychat/backend": patch
---

Remove backend-owned Fireflies ingestion: the ingest services and `/api/connectors/credentials` and `/api/connectors/meetings` routes, the host-allowlist guard and post-delivery hook on the public webhook route, and the related deploy environment names. The browser Fireflies sync, Calendar autojoin credential custody and Exo are unchanged.
