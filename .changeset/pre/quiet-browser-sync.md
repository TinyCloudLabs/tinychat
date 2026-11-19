---
"@tinychat/frontend": patch
---

If your sign-in method can't support this device's sync, sync now stops quietly for that session instead of retrying. Syncing everything to this device after sign-in can take a little longer to finish. A new account no longer logs connector errors on its first sign-in.

Details: TC-2685
