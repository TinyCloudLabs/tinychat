---
"@tinychat/backend": patch
---

The backend's own TinyCloud session now names the keys it uses in its storage space, instead of the SDK's default grant over the whole space. Its 30-day lifetime is unchanged and now set explicitly. Nothing changes for people using TinyChat.

Details: TC-3443
