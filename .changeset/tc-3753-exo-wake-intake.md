---
"@tinychat/backend": patch
---

The Exo wake route takes at most 6000 wakes a minute across all owners, whether or not the owner holds a grant. A wake past that gets the usual answer and is dropped. The backend reuses an owner's opened grant for 30 seconds, so one wake check makes one grant lookup, and a grant that is stored or removed through the backend is forgotten at once.

Details: TC-3753
