---
"@tinychat/backend": patch
---

TrustBot requests access to one secret's own encryption key for each approved call. Secrets still sealed with the account's encryption key need to be migrated before TrustBot can use them.

Details: TC-3805
