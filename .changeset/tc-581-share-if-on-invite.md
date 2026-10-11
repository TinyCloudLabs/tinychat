---
"@tinychat/backend": minor
"@tinychat/frontend": patch
---

Calendar auto-join sends one bot when two connected accounts auto-join the same Meet (TC-581). The second account sees "Already being recorded by another TinyCloud account" instead of a failure. Behind `CALENDAR_AUTOJOIN_SHARING` (default off), it gets the transcript only if its verified Google email accepted the bot owner's own invite. Shared recordings show as "Shared recording" and can be removed from your list but not ended or deleted. Auto-join now also asks for the `email` scope; existing connections must reconnect before they can receive a share.
