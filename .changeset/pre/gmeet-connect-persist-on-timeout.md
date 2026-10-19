---
"@tinychat/frontend": patch
---

Google Meet connect now keeps the connection when finishing the sync times out: the connection is saved as connected with a sync error, Drive Notes have their own time budget, and Retry finishes without reconnecting. If the connection itself can't be saved, the dialog says so and offers to connect again.
