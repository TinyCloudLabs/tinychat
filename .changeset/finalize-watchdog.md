---
---

Fix: stopping a long voice note under CPU pressure no longer fails with "Recording finalization timed out". Finalization now fails only when it stops making progress (not on a fixed 60 s budget), retries back off 2 s then 30 s then on next launch, and "Try again" works after a failed automatic retry.
