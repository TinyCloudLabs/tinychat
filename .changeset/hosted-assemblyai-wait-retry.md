---
"@tinychat/backend": patch
"@tinychat/frontend": patch
---

Powerful transcriptions that the provider cannot take right away now wait and finish by themselves instead of failing. The server keeps the audio and retries (after 1, 2, 5 and 10 minutes, then every 10) for up to 24 hours, never sending the same paid request twice when the outcome is unclear. The note and the upload sheet show "Transcription delayed" with a calm explanation while it waits.
