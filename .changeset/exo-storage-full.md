---
"@tinychat/frontend": minor
"exo-desktop": minor
---

Handle a full TinyCloud storage across voice notes. While storage is full, audio uploads pause: the audio stays on this device and shows as waiting for space. Each upload pass tries audio at most once while storage refuses it, so a full store is not probed once per note. The storage message is the same everywhere it appears. Plan detail appears only on the Settings banner and dialog, and Upgrade shows only when the plan is positively Free and the paywall is on. "Manage storage" opens the storage page in the external browser. Settings shows the storage state, and the upload and transcriber switches show "Paused: storage full".

A transcript that storage refuses is handled by where it was transcribed:

- On this device, the transcript is held on the device and marked as kept until space is available. A held transcript is retried on foreground, and after a successful write to storage. A transcript that is still refused stays held. A successful write that lands while a recovery pass is already running doesn't trigger another pass; the next write or a foreground event (focus, visibility, app active) does.
- Private, a storage-full save fails the transcript with a non-retryable `storage_full` failure. It says the transcript wasn't saved and offers Manage storage, then Transcribe again. It says the recording is safe on this device only when the local audio is confirmed ready. Nothing retries it automatically.

Private and hosted transcript retention (keeping a refused transcript for a later save) is not part of this change.

A transcript save on this device that times out fails with its own "took too long" message and can be retried. It is a persisted failure, not a storage hold.
