---
"@tinychat/backend": patch
---

TC-2917: calendar autojoin reads consent from the node before every Google scan and recording check, and every connection write re-reads the stored row first, so a disable or deletion stored outside the backend is kept. The row cache is bounded, and a cached access token is dropped when any credential store in the process changes that credential.

Every calendar row and credential write or delete is now conditional on the version it was decided on (If-Match / If-None-Match; a row the node sends without an ETag is refused, never written blind), and each row carries a revision so the node's content-hash ETag changes on every write. Enable and OAuth setup re-decide on the stored row. A token refresh is bound to the grant it read and re-reads custody after writing; cached access tokens serve at most 5 minutes after their custody read, and a status read showing a disable evicts them. markUsed is conditional and never recreates a deleted credential.
