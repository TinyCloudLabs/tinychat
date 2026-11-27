---
"@tinychat/bots": patch
---

The bots service sends the backend's required request header on its signed reads, refusal reports and owner-settings lookups. The backend refuses a POST without it ahead of every route, so a granted meeting, feed card or chat read can reach its owner's data and return it to TrustBot.

Details: TC-4423
