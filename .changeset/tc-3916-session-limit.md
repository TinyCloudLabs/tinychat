---
"@tinychat/backend": patch
---

One browser can make 600 general API requests per 15 minutes, so a normal page load with polling doesn't hit "Too many requests". Chat sends and signed-out clients have their own limits.

Details: TC-3916
