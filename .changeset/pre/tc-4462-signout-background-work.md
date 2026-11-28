---
"@tinychat/frontend": patch
---

Signing out with background work queued reports no uncaught error, and the background queue keeps running after a task in it fails. A transcript preview read cut off by sign-out is not logged as an error. The notetaker outcome reasons show in the Capture meeting sheet.

Details: TC-4462
