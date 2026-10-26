---
"@tinychat/frontend": patch
---

Connector keys read from the vault are cached in memory for the signed-in session, so repeat reads no longer make a network round trip. The cache is cleared on sign-out, account change and vault lock.

Details: TC-2080
