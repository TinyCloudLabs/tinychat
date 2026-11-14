---
"@tinychat/frontend": patch
---

Main's earlier messages load faster: the app fetches and decrypts up to four of them at a time instead of one after another. Every check on each message is unchanged, and the first failure still stops the whole load. Details: TC-3054.
