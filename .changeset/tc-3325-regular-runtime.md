---
"@tinychat/backend": patch
---

Adds a second bots service for Free bots. It runs each bot in its own sandbox on Google Cloud and has the same internal API as the bots service. Nothing changes for people using bots: the backend does not send any bot to it.

Details: TC-3325
