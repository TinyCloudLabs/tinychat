---
"@tinychat/backend": patch
---

Background transcript delivery removes a user's stored delivery grant only when the TinyCloud node reports it revoked or expired. When activating the grant gets 401 or 403, it asks the node for the grant's status. For any other answer it keeps the grant, retries and logs the reason (never the delegation id).

Details: TC-3076
