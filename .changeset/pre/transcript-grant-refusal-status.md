---
"@tinychat/backend": patch
---

Background transcript delivery keeps a person's saved delivery permission through temporary errors. It removes the permission only when the TinyCloud node reports it as revoked; any other refusal is retried and logged.

Details: TC-3076
