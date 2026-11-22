---
"@tinychat/backend": minor
---

Before an agent turn starts, the credit check uses that turn's model: the remaining credits must cover one short turn on it (8,000 input and 1,000 output tokens). That is 150 credits on GLM 5.2, 31 on Qwen 3.6 35B and 390 on Kimi K3. A turn the credits can't cover is refused. Each settled turn records its credit cost in the logs, without IDs.

Details: TC-3734
