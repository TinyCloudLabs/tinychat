---
"@tinychat/backend": patch
---

The backend accepts both tinycloud.chat and home.tinycloud.xyz for CORS, sign-in (the SIWE domain) and Google OAuth returns, through the new `FRONTEND_ORIGINS` allowlist: comma-separated exact origins, `FRONTEND_URL` always added, defaulting to `https://tinycloud.chat,https://home.tinycloud.xyz`. A Google connection started on tinycloud.chat returns to tinycloud.chat even after `FRONTEND_URL` moves to home.tinycloud.xyz; one started on home.tinycloud.xyz returns there. Stripe and connector-off links still use `FRONTEND_URL`.

Deploy this backend before setting `TINYCHAT_FRONTEND_URL` to `https://home.tinycloud.xyz`. That variable is also the backend's `FRONTEND_URL`, and an older backend would stop accepting tinycloud.chat, where visitors whose recordings are still only in that browser stay.
