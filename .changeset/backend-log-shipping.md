---
"@tinychat/backend": patch
---

Ships backend operational logs to the log service through a filtering sidecar. Only fixed-code fields leave the service. At the daily byte budget the shipper drops logs until 00:00Z; it never exceeds it. Details: TC-1978
