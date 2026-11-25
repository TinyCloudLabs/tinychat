---
"@tinychat/backend": patch
---

A chat reply now holds the credits it may spend from the moment it is admitted until it is charged, so replies running at the same time can no longer each spend the same remaining credits. A request that arrives with nothing left, whether other replies hold it or the ledger has not caught up yet, gets the usual out-of-credits response, and a hold that is never released lapses on its own. `/api/chat` holds only what its request can cost and caps its output to fit, and is charged what the model reports it used. Stopping a reply now charges what it used up to the Stop, including the part of a model call still streaming and any reasoning it produced, estimated so that non-Latin text and text inside message parts are not undercharged. A reply that hits our turn timeout is free, up to 10 such replies per account in 24 hours; past that, a timeout that delivered an answer is charged like a Stop. The turn clock pauses while the client is not reading, and a reply that runs out of time because the client stopped reading is charged like a Stop. Each model call's output is capped to what the model can stream in the time the turn has left, and a model call that streams past its cap is cut off and charged for what the model reports it used.

Details: TC-3487, TC-3488, TC-4203
