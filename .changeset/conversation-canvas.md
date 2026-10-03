---
"@tinychat/frontend": minor
"@tinychat/backend": patch
---

Experimental Conversation Canvas, off by default: Settings → Experimental Features → Conversation Canvas adds a Chat/Canvas switch to each chat for visualizing branches, continuing from an earlier message, and pinning versioned Markdown documents into the next request. Accounts that never turn it on never touch Canvas storage. The backend's app manifest adds the `canvas` SQL permission Canvas stores its data under.
