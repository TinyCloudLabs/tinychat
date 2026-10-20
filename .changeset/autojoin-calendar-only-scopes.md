---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Calendar autojoin now asks Google for Calendar events, openid and email only, and no longer asks for the Meet, Drive and Docs scopes or for previously granted scopes. Enabling it no longer saves a Google Meet token or runs a Meet sync; Google Meet stays a separate connect. Existing autojoin connections are not changed until the user reconnects.
