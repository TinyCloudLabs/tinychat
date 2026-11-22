---
"@tinychat/frontend": patch
---

When your session expires, signing you out keeps the work this device has not sent yet: post drafts, answers waiting to be sent, finished transcripts waiting to be saved and the records of uploads and transcriptions in progress. It is kept for your account only. Another account that signs in on the same device can't see it or send it, and it is there again when you sign back in. Signing out yourself removes all of it. Opening a new chat signs you out only when the server refuses your session, and on the phone apps only after one try to renew it.

Details: TC-3743
