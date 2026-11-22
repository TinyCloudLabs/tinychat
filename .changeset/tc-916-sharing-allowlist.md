---
"@tinychat/backend": patch
---

Calendar auto-join can share a meeting transcript between test accounts listed in `CALENDAR_AUTOJOIN_SHARING_ACCOUNTS` while sharing stays off for everyone else. Both accounts must be on the list. An empty list means nobody.

Details: TC-916
