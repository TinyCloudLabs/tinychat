---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Fireflies meeting import permissions are removed when you disconnect, delete your Fireflies meetings, delete your account or turn off instant updates, and expired ones are cleared automatically. A Fireflies key saved in an older format now asks you to save it again instead of retrying. The Library drops deleted Fireflies meetings at once.

Details: TC-3917
