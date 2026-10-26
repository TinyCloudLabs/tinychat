---
"@tinychat/frontend": patch
---

An open tab that is idle or hidden makes far fewer background reads of the library: the transcriber library sync no longer runs on its timer while the tab is hidden, and a tab with nothing to retry checks every two minutes instead of every 30 seconds. A recording that failed to save still retries every 30 seconds, and coming back to the tab still starts a check at once.
