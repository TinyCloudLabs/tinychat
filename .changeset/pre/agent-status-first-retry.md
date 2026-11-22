---
"@tinychat/frontend": patch
---

The app retries a failed agent status check after 10 seconds. A second failure waits 4 minutes; later failures wait 5 minutes.

Details: TC-3739
