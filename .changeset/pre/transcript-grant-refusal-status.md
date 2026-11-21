---
"@tinychat/backend": patch
---

Background transcript delivery removes a user's stored delivery grant only when the TinyCloud node refuses it with its revocation code. Any other 401 or 403, on activating the grant or on using it, keeps the grant, retries and logs the reason (never the delegation id).

Details: TC-3076
