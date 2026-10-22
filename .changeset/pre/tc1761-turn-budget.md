---
"@tinychat/backend": patch
---

Agent chat turns now stay within the remaining daily credit budget. A pre-flight check compares remaining credits against the minimum turn cost (log-only by default, `AGENT_CHAT_BUDGET_PREFLIGHT=enforce` returns 402). An in-turn check on Eliza usage frames stops the turn according to `AGENT_CHAT_BUDGET_STOP_MODE`: `finish_answer` (default) finishes the answer in progress, bounded to one extra step; `hard_stop`, `predict_next_round`, and `off` are also available.
