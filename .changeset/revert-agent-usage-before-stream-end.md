---
"@tinychat/backend": patch
---

Restore the 0.7.0 agent-chat response ending. The 0.7.1-beta.0 change that recorded agent-turn credit usage before ending the response made some replies end early ("The connection ended before the reply finished."), so it is reverted until a fix that keeps the error response.
