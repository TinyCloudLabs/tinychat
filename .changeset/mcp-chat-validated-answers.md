---
"@tinychat/backend": patch
---

The validated meeting answer pipeline (interpretation, evidence ledger, draft validation, one repair, evidence fallback, coverage) now runs for accounts served by MCP chat when the meeting content rollout flags admit them; its reader compatibility check no longer calls eliza-service. Default behaviour is unchanged. Details: TC-2196
