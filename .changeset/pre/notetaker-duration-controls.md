---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

Send a notetaker now has a "Stop after" choice (30 minutes to 4 hours, one hour by default), sent to ptx as `max_duration_seconds`. A live notetaker shows "Stops at …" from the server's scheduled stop time and offers +15 min, +30 min and No limit; No limit is still capped at four hours, and nothing is offered once the cap is reached. The backend passes the duration through on create and adds `PATCH /api/transcriber/meetings/:id` for the owner of a live notetaker (a shared calendar capture cannot be extended).
