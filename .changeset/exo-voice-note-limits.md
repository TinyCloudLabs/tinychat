---
"@tinychat/frontend": minor
---

Exo mobile voice notes are capped at 60 minutes and stored in parts, so long notes save and play back.

- **60-minute limit.** The phone's recorder (Android and iOS) stops a note by itself at 60 minutes, the same way Stop does, and the note is saved like any other. The card shows the limit in the last five minutes ("Recording 55:00 of 60:00") and says "Stopped at the 60-minute limit." afterwards. A recording left running can no longer grow to hundreds of megabytes (6 hours was 188 MB).
- **Stored in 1 MiB parts.** Audio is stored in the user's space as raw parts of at most 1 MiB plus a manifest written last, read from the phone one part at a time. The production node's ingress refuses request bodies over 1 MiB, so the old single base64 value failed for notes longer than about a minute and a half. A save that fails partway leaves the note on the phone, and "Save now" resumes after the parts already stored without writing anything twice.
- **Playback and transcription read the parts.** The player loads a note part by part (with progress) into an object URL. Notes saved before this change, stored as one value, still play and transcribe.
