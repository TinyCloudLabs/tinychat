---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Sign-in no longer asks for read, write and delete on every app folder in the applications space. It asks for read access to the one folder the Ledger app opens, and for the voice-note job folder One already uses. Explorer's all-apps read now asks when it is first needed. People re-sign in once per device.

Details: TC-2043
