---
"@tinychat/frontend": patch
---

Put less load on your space's meetings database. The Library list finds each voice note's older transcript in one pass instead of rescanning every row for every note. The TinyCloud Transcriber sync no longer reads every saved transcript to compare versions, runs once per interval across all open tabs instead of once per tab (a tab stuck for more than a minute hands over to the others), and waits while the device is offline. After a database save times out, retries wait until the space has finished the abandoned request instead of queueing behind it.
