---
"@tinychat/frontend": patch
---

Production web saves each connector key under its own encryption key, so a service you approve for one key can read only that key.

Details: TC-3284
