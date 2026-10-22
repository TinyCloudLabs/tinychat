---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Combined-meeting summaries now use a faster model and a per-call output cap. The chat route accepts an optional `max_output_tokens` integer (1 to 4096), forwarded upstream as `max_tokens`. Details: TC-1686
