---
"@tinychat/frontend": patch
---

Google Meet in Meeting sources: a Full rescan or Sync now that another Meet sync refuses (including the run its own vault unlock started) shows that sync's progress and starts by itself when it ends, instead of "Another Google Meet sync is already running". The meeting count is the live count of saved meetings, refreshed at every checkpoint and when a sync settles. The connect dialog says how many Meet recordings synced and how many meetings are saved. The sync log is saved when a run starts and at each checkpoint, so a run a reload cuts short leaves one, and "Copy sync log" is on the row. After a reload the row says "A Notes sync was interrupted at x/y. Sync now resumes it."
