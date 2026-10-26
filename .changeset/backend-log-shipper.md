---
"@tinychat/backend": patch
---

The production backend CVM now runs a private log shipper sidecar. It sends startup lines (including `[startup] FATAL` and crash lines), hosted-AssemblyAI events and alerts to a private Better Stack source as typed fields only. It is inert until its source token is set, never gates the backend, and changes nothing for users.
