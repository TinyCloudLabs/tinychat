---
"@tinychat/frontend": patch
---

A Home page left open across a deploy no longer gets the app's page back for a missing script: missing build files return a real 404, and a failed lazy load (the TinyCloud panel's "This didn't load.", a screen that couldn't open) offers "New version available — Reload" when a newer build is live.
