---
"@tinychat/frontend": patch
---

Opening a bot chat, approving an app request or turning on Conversation Canvas with an OpenKey-managed key shows OpenKey's own sign screen only, with no SDK permission dialog before it. An external wallet key keeps the SDK permission dialog. Saying no on OpenKey's sign screen counts as a decline, so a bot chat does not ask again until you choose to review the request.

Details: TC-4210
