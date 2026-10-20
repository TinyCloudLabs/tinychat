---
"@tinychat/frontend": patch
---

Google Meet in Meeting sources: Sync now and Full rescan return once the Meet records are saved and the Notes finish in the background (own time budget, checkpoints, progress on the row), so a slow storage node no longer hits the 60 s foreground limit and needs several presses. The status line follows the latest run: a finished run clears an earlier "Last sync failed", and "synced" shows when the run ended. The meeting count rises with every saved Note. A request for the Google access token that the network closes is sent once more before the row says it couldn't reach Google.
