---
"@tinychat/backend": patch
---

Calendar auto-join can share a meeting transcript between test accounts listed in `CALENDAR_AUTOJOIN_SHARING_ACCOUNTS`. Sharing is off for every other account. Both accounts must be on the list, and an empty list turns sharing off.

Details: TC-916
