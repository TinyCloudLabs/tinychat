---
"@tinychat/backend": patch
---

Activate exactly scoped Exo sync grants: KV get, list, and del on the `requests/` prefix, and get, put, and del on the `jobs/` prefix. A typed accessor refuses traversal, encoded, and sibling paths before any KV call. Exo and connector grant records are bound to their own kind and key prefix, and connector records written before this change still load. `EXO_CAPABILITIES_ENABLED` stays off by default.
