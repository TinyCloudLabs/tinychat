---
"@tinychat/backend": patch
---

TC-2917: calendar autojoin row writes are If-Match compare-and-sets on the node, a token refresh writes custody only if no other change happened since it was read, and the cached access-token map is bounded and evicted on expiry, disable or a new generation.
