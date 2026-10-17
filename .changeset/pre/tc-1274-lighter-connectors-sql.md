---
"@tinychat/frontend": patch
---

Put less load on your space's meetings database. The Library list finds each voice note's older transcript in one pass instead of rescanning every row for every note. The TinyCloud Transcriber sync no longer reads every saved transcript to compare versions, checks only meetings it hasn't already confirmed this session, runs once per interval across all open tabs instead of once per tab (a tab whose sync makes no progress for a minute hands over to the others), and waits while the device is offline. After a database save times out, retries wait until the space has finished the abandoned request instead of queueing behind it.
