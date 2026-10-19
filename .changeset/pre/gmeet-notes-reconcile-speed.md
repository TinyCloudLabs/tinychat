---
"@tinychat/frontend": patch
---

Google Meet connect now finishes in seconds. The connection is saved as soon as the meetings are checked, and Notes by Gemini reconcile in the background: the Drive listing is limited to Google Docs, existing notes are matched in memory instead of one database scan per Doc, Docs are read up to five at a time with per-call timeouts, and progress is checkpointed so Retry resumes instead of restarting. The dialog shows real progress, per-phase counts and elapsed time, and a "Copy sync log" button (counts, timings and error kinds only). A background failure shows on the Google Meet card.
