---
"@tinychat/backend": patch
---

The backend grants its own session the three TrustBot key roots it uses (Telegram read grants, read audit and standing read approvals), which clears the 503 on the reads status routes. The reads and history grant routes log the error class and a short code when they answer 503.

Details: TC-4354
