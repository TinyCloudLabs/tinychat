---
"@tinychat/frontend": patch
---

Fixes the Google Meet sync dialog getting stuck after the last meeting; it doesn't speed up slow storage responses, so a slow sync may now end with an error and a Retry button instead of hanging.

Web only; no desktop or mobile release.
