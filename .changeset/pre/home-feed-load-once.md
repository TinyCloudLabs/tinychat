---
"@tinychat/frontend": patch
---

Home Feed loads once per open. A live-update connect, reconnect or resume no longer reloads the whole Feed: the first load waits for the live-update stream, and each later stream compares a one-request-per-database fingerprint with the last one and reloads only when something changed. A resume within 60 s makes no requests.
