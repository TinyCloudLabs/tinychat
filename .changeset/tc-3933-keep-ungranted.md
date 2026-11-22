---
"@tinychat/backend": patch
---

If you haven't approved saving a bot's chat history to TinyCloud, the bot's chat and files are kept until you start a new chat or delete the bot. The clean-up of unused bots leaves them alone. New messages in such a chat still aren't saved.

Details: TC-3933
