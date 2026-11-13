---
"@tinychat/frontend": patch
---

The Home Feed refreshes in one round of requests instead of three or more. On open it reads the agent registry and every agent the device already knows at the same time, one request per database, and no longer waits for the live-update stream first: each read carries its own freshness fingerprint, so the stream's first ready compares instead of loading again. Answers, follow-ups and agent receipts come with those reads instead of one request each, in sequence. A new device reads the Feed before it creates its tables; the one-time schema batch runs after the first load.
