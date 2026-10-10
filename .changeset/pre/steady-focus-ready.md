---
"@tinychat/frontend": patch
---

Test infrastructure: the Meeting sources e2e waits for Radix to move focus instead of reading it the instant the sheet unmounts, and the exo-ui harness readiness cap runs on `performance.now()` so `?freeze=1` can no longer hang a never-ready screen.
