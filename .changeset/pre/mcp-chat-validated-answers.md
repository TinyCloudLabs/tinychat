---
"@tinychat/backend": patch
---

The validated meeting answer pipeline (interpretation, evidence ledger, draft validation, one repair, evidence fallback, coverage) now runs for accounts served by MCP chat when the meeting content rollout flags admit them; its reader compatibility check no longer calls eliza-service. For MCP turns only, `MEETING_CONTENT_TEST_ACCOUNTS` accepts `*` and an empty `MEETING_CONTENT_MODELS` admits every offered model. Claim citations in the validated render now carry the speaker and time, `[M1:E3, Speaker, hh:mm:ss]`, as tool results already do. An MCP turn refuses a tool name the MCP wrapper does not serve instead of forwarding it to eliza-service. Default behaviour is unchanged. Details: TC-2196
