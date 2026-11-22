---
"@tinychat/frontend": patch
---

When your session expires, signing you out keeps the work this device has not sent yet: post drafts, answers waiting to be sent, finished transcripts waiting to be saved and the records of uploads and transcriptions in progress. It is kept for your account only. Another account that signs in on the same device can't see it or send it, and it is there again when you sign back in. Signing out yourself removes all of it, also when it happens while an expired session is signing out. Opening a new chat signs you out only when the server refuses your session. On the phone apps it first tries once to renew the session, unless the session began or was renewed in the last minute or a failed renewal is waiting to retry. On tinycloud.chat and home.tinycloud.xyz, the notice that keeps a tab there counts your own unsent answers; another account's unsent answers get a line of their own and keep the tab there for up to 7 days.

Details: TC-3743
