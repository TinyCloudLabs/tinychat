---
"@tinychat/frontend": patch
---

The recorder checks Private transcription again when the account is ready and when the app returns to the foreground, and shows "Checking…" or a failed check with "Check again". Local's "Get the on-device model" now starts the download with visible progress, size and errors, and a saved note waiting on the model says so (with a way to get it, retry, or the reason it failed) instead of "No transcript."
