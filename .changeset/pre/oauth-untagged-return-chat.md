---
"@tinychat/backend": patch
---

Google connections started on tinycloud.chat keep returning to tinycloud.chat after the backend's web app address (`FRONTEND_URL`) moves to https://tinycloud.one. A connection started without a site tag, which is how a visitor still working on tinycloud.chat starts one, now finishes on tinycloud.chat, as it already did when the address was home.tinycloud.xyz. Connections started on tinycloud.one or home.tinycloud.xyz still return to their own site. This release changes no settings. Set `FRONTEND_URL` to https://tinycloud.one only with this backend or after it.
