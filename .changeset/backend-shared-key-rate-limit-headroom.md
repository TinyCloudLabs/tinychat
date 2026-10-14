---
"@tinychat/backend": patch
---

Stop one busy browser from rate-limiting every user. In production every client reaches the backend from the Phala gateway's single address, so each rate-limit bucket is shared by all users. Every ceiling is now its per-client budget times 50 (global 6,000 per 15 minutes), `/health` is in no bucket, and private cloud job-status polls get their own bucket instead of sharing the transcriber one. Interim until per-client keying ships.
