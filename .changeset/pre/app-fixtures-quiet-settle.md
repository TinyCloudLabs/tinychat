---
---

The two mounted-App test fixtures for session re-sign wait for the page to go quiet instead of a fixed number of event-loop turns, so they no longer fail on a slow CPU. Details: TC-3029.
