---
"@tinychat/backend": patch
---

Reads are always audited when standing reads are enabled: each TrustBot read of the owner's data is recorded before it runs, and a read that cannot be recorded does not run. Logging of blocked attempts is bounded. Keep 90 days of counts by day, area and tool.

Details: TC-4000
