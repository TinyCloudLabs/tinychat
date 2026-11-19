---
"@tinychat/frontend": patch
---

Missing build files return a real 404, so a Home page left open across a deploy doesn't get the app's page back for a missing script. A failed lazy load (the TinyCloud panel's "This didn't load.", a screen that couldn't open) offers "New version available — Reload" when a newer build is live.
