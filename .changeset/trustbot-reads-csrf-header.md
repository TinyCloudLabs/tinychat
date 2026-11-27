---
"@tinychat/bots": patch
---

TrustBot's meeting, feed and chat reads reach the backend again. The backend's CSRF gate refused every read call because the gateway sent no `X-Requested-With` header, so each read said only that it could not read right now.
