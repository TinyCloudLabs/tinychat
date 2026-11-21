---
"@tinychat/backend": patch
---

The backend now states the storage access it needs in its own space when it signs in, so a later upgrade of the TinyCloud library cannot cut it off from its own data. It asks to read, write, delete and list there and for nothing else.

Details: TC-3671
