---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Details: TC-1977 Store connector credentials in app named keys again. Web sign-in runs OpenKey's authorize review inside the embedded OpenKey frame, so it needs no popup or extra approval screen, and the backend serves the named-key manifest rows only to requests that send `keys=1`.
