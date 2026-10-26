---
"@tinychat/frontend": patch
"@tinychat/backend": patch
---

A voice note that Private transcription is holding shows "Transcription is delayed, it will finish automatically." instead of an error, and keeps checking until it finishes. A note whose Private transcription stopped on a speech-to-text provider failure is re-submitted once, automatically, the next time the app loads and the recording is still on the device; if it fails again it waits for Retry.

Details: TC-2085
