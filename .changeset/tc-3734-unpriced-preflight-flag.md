---
"@tinychat/backend": patch
---

An agent turn on a model with no catalog price must be covered by the fallback minimum of 2,600 credits. Its preflight log event carries `unpriced: true`, so an unpriced model shows in the logs even when every turn on it is refused. Priced models leave the field out.

Details: TC-3734
