---
"@tinychat/frontend": patch
---

Home opens its connections to the TinyCloud node and the backend while the app bundle loads (`preconnect` and `dns-prefetch` hints for the build's configured origins), so the first request after the session restores no longer also pays DNS, TCP and TLS.
