---
"@tinychat/frontend": patch
---

Limit the approval that opens older encrypted bot history to 1 hour and say what it covers: everything encrypted with the account's main key, including older bot chats, saved secrets and keys for connected services. While that approval is held, the records of every bot are moved to the history key in one pass, including bots that were not opened.

Details: TC-4102
