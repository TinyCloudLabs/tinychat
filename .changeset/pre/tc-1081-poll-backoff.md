---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Reduce PTX and hosted transcription status polling after the initial fast phase, honor rate-limit retry deadlines, expose limiter headers to browser clients, and keep throttling separate from failure budgets.
