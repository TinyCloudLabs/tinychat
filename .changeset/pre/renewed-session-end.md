---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

A session restored through its renewal lease keeps reading bot history past the end its sign-in message names. The backend binds the renewed end it verified at sign-in renewal into the session bearer, for that session key only and never past the owner-signed lease, and accepts the session's history key descriptor and history grants up to that end. One reads the same end from the bearer, so it stops showing the session as signed out while the renewal holds. A session without a renewal keeps its signed end.

Details: TC-4322
