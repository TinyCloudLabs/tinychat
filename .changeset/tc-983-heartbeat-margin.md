---
"@tinychat/frontend": patch
---

(TC-983) Keep the transcriber heartbeat at 50 minutes; with successful passes of ≤ 60 seconds and timely 30-second timer execution, `checked_at` lag is ≤ H + 2D + I = 50 min + 2×60 s + 30 s = 52 min 30 s < 1h30s.
