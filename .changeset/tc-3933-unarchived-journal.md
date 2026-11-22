---
"@tinychat/backend": patch
---

Chats with TrustBot and your other bots keep working when you never approved saving their history to TinyCloud. Those chats used to keep a saved copy that only grew, and after enough use every message failed and New chat could not clear it. A chat with no approval keeps no copy, and New chat clears it at once. Saving starts when you approve it, and messages from before your approval are not saved.

Details: TC-3933
