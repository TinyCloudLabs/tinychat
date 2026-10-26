---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Hosted transcription refusals are now classified (rejected key, insufficient balance, rate limit) and reported to operators: one alert when AssemblyAI starts refusing, one when it recovers, one after three failed jobs in a row, a heartbeat every minute, and a read-only status for the monitoring probe. Nothing changes for users yet.
