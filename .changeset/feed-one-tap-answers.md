---
"@tinychat/frontend": minor
---

Answering a card in the Home feed takes one tap. The option you tap stays pressed with a 4-second countdown and Undo; when it ends the answer is sent, the card folds to a line that says what you chose, and three steps tick as they arrive: Sent, Agent received, then Completed or Failed, each with its time. A typed answer keeps its own Send, with the same countdown. Plain question cards and typed asks work this way; approvals keep their own button and are unchanged. A failed send shows its error beside the options with Try again. A build served from a sub-path (`vite build --base`) now routes and loads its header icon from that path. For development, a build made with `VITE_FEED_LAB=true` adds `/feed-lab`: the real feed cards on made-up data, with a simulated agent and no sign-in; every other build is unchanged by it.
