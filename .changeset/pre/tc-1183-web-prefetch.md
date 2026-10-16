---
"@tinychat/frontend": patch
---

Prefetch the web sign-in manifest and single-use nonce while OpenKey connects, refreshing stale nonces before signing. Requires backend SIWE domain and URI validation (TC-1201) before preview or release; native sign-in is unchanged.
