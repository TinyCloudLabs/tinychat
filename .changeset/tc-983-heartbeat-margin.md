---
"@tinychat/frontend": patch
---

(TC-983) Lower the transcriber snapshot heartbeat to 50 minutes, bounding `checked_at` lag to ≤ 50 min + 30-second interval + ≤ 60-second pass duration < 1h30s.
