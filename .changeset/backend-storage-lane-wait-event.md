---
"@tinychat/backend": patch
---

The backend log shipper now sends storage-lane wait warnings (slow wait, wait timeout) as a typed event with the operation, lane priority and wait time. Nothing changes for users.
