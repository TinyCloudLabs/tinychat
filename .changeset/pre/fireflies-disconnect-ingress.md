---
"@tinychat/backend": patch
---

Stop webhook admission on Fireflies disconnect, close the in-flight enqueue race, and retain purge-ledger ID timestamps without extending them on retries.
