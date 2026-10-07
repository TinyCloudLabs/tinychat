---
"exo-desktop": patch
---

Keep private cloud recordings when the Local recording view closes mid-recording, or when Exo quits before the upload finishes. The next view or launch offers a recording that was never uploaded (Transcribe in private cloud, Transcribe on this Mac, or Discard) and re-sends an interrupted upload. After a relaunch, native code re-opens the audio by session id, only inside Exo's sessions folder and without following symlinks. Every upload of a recording uses the same Idempotency-Key, so it never creates a second transcription job. The pending record is now per account, so another account never sees, resumes or clears it. A pending record from an older version is adopted only by the account whose backend can read its job. A set-aside job's upload handle is released (TC-772).
