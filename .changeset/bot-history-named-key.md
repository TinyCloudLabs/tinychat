---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

TrustBot's chat history uses its own encryption key. New history can be saved with an approval for that one key. When you open earlier messages with their existing encryption approval, TinyChat can move them to the new key.

Details: TC-3823
