---
"@tinychat/frontend": patch
---

Chat replies start streaming without waiting for the user message to be saved to TinyCloud SQL; the save runs alongside the stream and still lands before the reply, and a new chat's first message no longer reads a compaction checkpoint it cannot have. Every thread-store SQL call is now bounded (15s), so a dropped response fails as a retryable error instead of hanging that chat's saves for the rest of the session.
