---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Sync voice-note text independently of audio uploads and publish each local transcript revision once.
Make hosted Powerful jobs idempotent by account and note ID, persist submitted job keys across backend restarts, and reconcile stale client claims before resuming. Deploy the backend before or together with the frontend; the server-side key is required to prevent duplicate paid jobs.
