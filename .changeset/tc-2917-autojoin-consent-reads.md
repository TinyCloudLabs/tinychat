---
"@tinychat/backend": patch
---

TC-2917: calendar autojoin reads consent from the node before every Google scan and recording check, and every connection write re-reads the stored row first, so a disable or deletion stored outside the backend is kept. The row cache is bounded, and a cached access token is dropped when any credential store in the process changes that credential.
