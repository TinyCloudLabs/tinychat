---
"@tinychat/frontend": patch
---

Google Meet Notes: one Note's storage write is retried twice with backoff, and a Note that still fails no longer fails the run: the rest are saved, the card reports "N of M Notes saved", and Sync now or Full rescan resumes only the unsaved ones. The row is recounted after every background run. The session-start sync now reconciles Notes in the background like the connect dialog, so Full rescan and Sync now show the running sync's live progress (including a Notes sync resumed from an earlier page load) and offer to wait instead of failing. "Copy sync log" is on the Connectors card, kept per account across reloads.
