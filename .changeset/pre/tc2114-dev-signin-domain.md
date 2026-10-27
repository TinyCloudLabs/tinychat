---
"@tinychat/frontend": patch
---

Exo desktop development builds sign in again: the sign-in message is signed for `localhost` (the host the server accepts) instead of `localhost:5186`, and sign-in errors from the server are logged as short codes only. Published builds are unchanged.
