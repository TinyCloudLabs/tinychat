---
"@tinychat/backend": patch
---

While standing reads are enabled, the backend records every TrustBot read of the owner's data before it happens, and a read that cannot be recorded does not run. Logging of blocked attempts is bounded. Keep 90 days of counts by day, area and tool.

Details: TC-4000
