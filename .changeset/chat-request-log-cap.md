---
"@tinychat/backend": patch
---

Chat request records have their own log shipper cap, so polling routes cannot drop them.

Details: TC-4310
