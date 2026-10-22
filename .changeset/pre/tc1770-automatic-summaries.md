---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Add an "Automatic meeting summaries" setting, on by default. When it is off, a combined meeting is saved without a summary and Generate starts one. `GET /api/billing/status` now reports the same usage the chat admission gate uses, and the client refreshes it after a summary run.
