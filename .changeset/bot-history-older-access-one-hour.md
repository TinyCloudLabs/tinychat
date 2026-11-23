---
"@tinychat/frontend": patch
---

Limit the approval that opens older encrypted bot history to 1 hour and say so, including that it covers any secrets in that history. While that approval is held, the records of every bot are moved to the history key in one pass, including bots that were not opened.

Details: TC-4102
