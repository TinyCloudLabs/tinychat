---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Bot chat history in TinyChat is sealed with its own encryption key. Saving new history needs your approval for that one key. When you open earlier messages, TinyChat can move them to that key.

Details: TC-3823
