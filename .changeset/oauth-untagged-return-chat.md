---
"@tinychat/backend": patch
---

Google connections started on tinycloud.chat keep returning to tinycloud.chat after the backend's web app address (`FRONTEND_URL`) moves to https://tinycloud.one. A connection started without a site tag, which is how a visitor still working on tinycloud.chat starts one, now finishes on tinycloud.chat, as it already did when the address was home.tinycloud.xyz. Connections started on tinycloud.one or home.tinycloud.xyz still return to their own site. No setting changes: set `FRONTEND_URL` to tinycloud.one only with, or after, this backend.
