---
"@tinychat/backend": patch
---

Distinguish slow storage-lane waits from queue timeouts in private logs and include closed calendar failure classifications without account IDs, storage keys, values or error text. Preserve request-log rate limits and existing storage scheduling.

Bound every non-request log stream to ten samples per minute and retain pre-sampling outcome counts in one fixed-size summary per minute, without changing the existing request-record limits.
