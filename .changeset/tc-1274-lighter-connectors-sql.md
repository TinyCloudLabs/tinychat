---
"@tinychat/frontend": patch
---

Put less load on your space's meetings database. The Library list finds each voice note's older transcript in one pass instead of rescanning every row for every note, and the meetings database gains a source index the first time the app writes to it (best effort; nothing fails without it). The TinyCloud Transcriber sync no longer reads every saved transcript to compare versions, runs once per interval across all open tabs instead of once per tab, and waits while the device is offline. After a save times out, retries wait until the space has finished the abandoned request instead of queueing behind it.
