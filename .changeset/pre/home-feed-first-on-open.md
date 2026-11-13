---
"@tinychat/frontend": patch
---

Home loads the Feed first when it opens on the Feed. The chat list refresh, the first-screen, word fixes and Canvas settings reads, the memory check, the transcriber library sync and the background chat history copy now wait until the Feed's first network load has shown (at most 3 s), so the Feed's reads no longer queue behind them at the node. Lists stored on the device still show at once, and opening Chat or any other screen releases the waiting reads immediately. Two overlapping automatic model lookups now share one request.
