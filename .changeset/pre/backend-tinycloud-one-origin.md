---
"@tinychat/backend": patch
---

The backend accepts https://tinycloud.one, the Home app's new site, for CORS and the sign-in (SIWE) domain, alongside tinycloud.chat and home.tinycloud.xyz. It is one more exact origin in the default `FRONTEND_ORIGINS` list; `www.tinycloud.one`, other ports, other schemes and lookalike hosts are still refused. Google connections started on tinycloud.one still return to `FRONTEND_URL` until they get their own return tag.
