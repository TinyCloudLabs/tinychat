---
---

Fix a flaky iOS engine test: the 10-minute stall backoff test now uses an exact whole-second injected clock, and the capture tap stamps its time from the same injected clock.
