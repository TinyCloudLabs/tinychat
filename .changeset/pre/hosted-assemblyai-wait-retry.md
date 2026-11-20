---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Powerful transcriptions that the provider can't take right away wait and finish by themselves. The server keeps the audio and retries (after 1, 2, 5 and 10 minutes, then every 10) for up to 24 hours, and never sends the same paid request twice when the outcome is unclear. While it waits, the note and the upload sheet show "Transcription delayed" and say it will finish automatically.

Details: TC-2131
