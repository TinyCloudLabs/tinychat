---
"@tinychat/backend": patch
---

Issue the receipt for a bot history record that its owner has rewritten to the history key with its full context while the receipt was still pending. The stored record must be a bound envelope on the same key or a higher key version.

Details: TC-4108
