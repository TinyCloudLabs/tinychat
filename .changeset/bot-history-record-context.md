---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Verify the full record context when opening bot history. Records written from now on carry their owner, space, path and bot, and every read checks them. Earlier records still open and are reported as earlier records.

Details: TC-4041
