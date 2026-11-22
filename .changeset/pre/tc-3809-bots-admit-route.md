---
"@tinychat/backend": patch
---

The backend serves `POST /api/internal/bots/admit` for the bots gateway's sibling admission. The call is signed `to-backend` with `BOTS_BACKEND_CALL_SECRET`; the owner comes from the signed owner DID and the source from the signed bot, and both bots are looked up in that owner's registry record. Without the secret the route is not mounted.

Details: TC-3809
