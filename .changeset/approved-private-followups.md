---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Allow TrustBot to propose and deliver an exact owner-approved message to one or more admitted bots after reading private data. Approval remains bound to the owner, recipients and message and can be used only once; unapproved exports remain held.

Keep the backend's reply deadline longer than the bot's configured turn budget. Distinguish an interrupted connection from an execution timeout so an already-running task is not described as unable to start.
