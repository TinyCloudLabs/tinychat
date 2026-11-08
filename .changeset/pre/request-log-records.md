---
"@tinychat/backend": minor
---

Ship one metadata record per request to the private log sink: request id, route template, method, status, duration, stream outcome and code, credits charged and a keyed account hash (new optional `REQUEST_LOG_HMAC_KEY`). Records are capped per minute and never carry bodies, headers, keys, emails or IPs. The local `tinychat_request` event's `route` now includes the mount template (for example `/api/chat` instead of `/`).
