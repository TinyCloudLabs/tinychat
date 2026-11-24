---
"@tinychat/backend": patch
---

A chat reply now holds the credits it may spend from the moment it is admitted until it is charged, so replies running at the same time can no longer each spend the same remaining credits; a request that arrives while other replies hold everything left gets the usual out-of-credits response, and a hold that is never released lapses on its own. `/api/chat` holds only what its request can cost and caps its output to fit. Stopping a reply now charges what it used up to the Stop, including the part of a model call still streaming, and a reply that hits our turn timeout is free.

Details: TC-3487, TC-3488, TC-4203
