---
"@tinychat/backend": patch
---

The Google OAuth routes accept a third purpose, `calendar-link`: a browser-held, read-only Calendar grant (`calendar.events.owned.readonly` and `openid`) for linking recordings to calendar events. The server keeps no token for it and it never changes Calendar autojoin. Revoking a `calendar-link` token asks Google to revoke only when no other feature holds the same Google grant; disconnecting Google Meet or Calendar autojoin skips the upstream revoke while the browser reports that calendar linking is still connected.
