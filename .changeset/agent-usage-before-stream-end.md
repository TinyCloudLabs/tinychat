---
"@tinychat/backend": patch
---

Record legacy agent-turn credit usage before ending the response so immediate follow-up chat requests enforce the updated budget. Preserve the existing soft-cap policy and streamed answer.
