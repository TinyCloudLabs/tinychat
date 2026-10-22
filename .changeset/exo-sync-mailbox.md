---
"@tinychat/backend": patch
---

Add a backend mailbox for Exo sync requests behind `EXO_CAPABILITIES_ENABLED`, which is off by default. The grant verifier now also accepts one exactly scoped Exo grant shape; connector grants are unchanged.
