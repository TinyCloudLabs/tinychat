---
"@tinychat/backend": patch
---

Calendar autojoin status for an account that never connected Google now returns "off" without listing occurrences, so the read no longer exceeds the client's 20s timeout and shows an error.
