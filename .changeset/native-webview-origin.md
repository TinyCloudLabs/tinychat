---
"@tinychat/frontend": minor
"@tinychat/backend": minor
---

After this update, the phone apps run from their own address, `app.tinycloud.one`, instead of a shared one. On the first launch they move what they kept only on your phone (unsent Feed answers and drafts, recording notes, held transcripts, transcription jobs, and your recording, theme and view settings), then delete the old copy. Sign-in keys and tokens aren't copied; they're renewed. You stay signed in, unless the phone's secure storage doesn't answer at that first launch; then you sign in again.

Details: TC-3045
