---
"@tinychat/backend": patch
---

Activate exactly scoped Exo sync grants: KV get, list, and del on the `requests/` prefix, and get, put, and del on the `jobs/` prefix. A flag-gated grant route, `GET|POST|DELETE /api/exo/v1/grant`, mounts only when `EXO_CAPABILITIES_ENABLED` is exactly `true`. A typed accessor refuses traversal, encoded, sibling, and lookalike paths, keys over 512 characters, stored values over 4 KiB, and invalid UTF-8 or byte-order-marked values before any KV call. Exo and connector grant records are bound to their own kind and key prefix, and connector records written before this change still load. `EXO_CAPABILITIES_ENABLED` stays off by default.
