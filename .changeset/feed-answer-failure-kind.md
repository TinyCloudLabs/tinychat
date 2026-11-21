---
"@tinychat/frontend": patch
---

When a Feed answer fails to send, the app keeps a short note of why on your device: an error code and status, never what you wrote. It keeps the last 20, so the cause can be traced.

Details: TC-3723
