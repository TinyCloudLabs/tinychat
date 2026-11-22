---
"@tinychat/backend": patch
---

The Exo wake route queues at most 600 wakes a minute for owners who hold a grant. A wake past that gets the usual answer and is dropped. The backend reuses an owner's opened grant for 30 seconds, so one wake check makes one grant lookup, and a grant that is stored or removed through the backend is forgotten at once.

Details: TC-3753
