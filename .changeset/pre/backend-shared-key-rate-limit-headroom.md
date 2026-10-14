---
"@tinychat/backend": patch
---

Stop the shared rate-limit key from taking every user down. In production every client reaches the backend from the Phala gateway's single address, so each rate-limit bucket is shared by all users. Interim, until per-client keying ships:

- Polling and read buckets scale by 50: global 6,000 per 15 minutes.
- Paid chat (`POST /api/chat`, `POST /api/agent/chat`) gets its own bucket of 600.
- Google OAuth: 150. Private cloud job mutations: 300. Calendar autojoin: reads 3,000, setup 150. Delegations: 600.
- Private cloud job-status polls leave the transcriber bucket for their own.
- `/health` and `/health/` are exempt.
- Paths are matched case-insensitively, so every request lands in exactly one bucket.
- The routes charged to the global bucket are counted, logged every 5 minutes and shown on `/health`.
