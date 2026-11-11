---
"@tinychat/backend": patch
---

Stop a chat reply at the credit limit and never charge above it (TC-2601). Backend-orchestrated replies cap every provider call's `max_tokens` from the allowance the account had when the reply started and end with `budget_exhausted` instead of overshooting; all chat paths (agent chat, Eliza tasks, `/api/chat`) now settle through one clamp: a reply is charged at most its starting allowance and at most what is left of the window it started in, a reply that fails before any answer content reached the user is free, and a timed-out reply is charged at most its starting allowance. The ledger record id is now the reply's execution id. Eliza `/tasks` monitor modes are unchanged. Customer-visible effect: replies near the limit can end early with the existing "reached the limit" notice, and overshoot is platform cost, not the user's. See `docs/credits.md`.
