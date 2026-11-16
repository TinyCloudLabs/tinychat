---
"@tinychat/backend": patch
---

Background transcript delivery no longer deletes a user's stored delivery grant just because the TinyCloud node answered 401 or 403 when activating it. It now asks the node for the grant's status and removes the grant only when the node reports it revoked or expired; otherwise it keeps the grant and retries, and logs the reason (never the delegation id). Details: TC-3076.
