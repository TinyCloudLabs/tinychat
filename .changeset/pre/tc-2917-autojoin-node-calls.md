---
"@tinychat/backend": patch
---

TC-2917: the calendar autojoin worker reads connection and meeting rows from an in-process copy instead of the node every 30 s tick. Idle users, disabled connections and finished meetings no longer cost node calls; scheduling, due-time timers and dispatch policy reads are unchanged.
