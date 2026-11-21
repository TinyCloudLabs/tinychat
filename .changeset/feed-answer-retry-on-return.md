---
"@tinychat/frontend": patch
---

An answer on a Feed card that fails to send while the app is switched away is sent once more when the app is open again, with the same answer ID, so it cannot be recorded twice.

Details: TC-3723
