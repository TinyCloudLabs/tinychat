---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

When a TrustBot read grant is replaced, TinyChat forgets the old grant once its revoke is confirmed and stops retrying after that. Grant records it can't read are dropped.

Details: TC-4027
