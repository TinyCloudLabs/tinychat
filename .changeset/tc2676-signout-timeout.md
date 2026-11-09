---
"@tinychat/frontend": patch
---

Bound OpenKey sign-out acknowledgement waits so a stalled widget no longer leaves Settings stuck on “Signing out…”. If the acknowledgement times out, the local session remains available for retry.
