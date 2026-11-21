---
"@tinychat/frontend": minor
---

After this update, the phone apps run from their own address, `app.tinycloud.one`, instead of a shared one. On the first launch they copy your unsent Feed answers and drafts, recording notes, held transcripts, transcription jobs and your recording, theme and view settings to the new address, and a later launch deletes the old copy once the copy is confirmed. Sign-in keys and tokens aren't copied; they're renewed. You stay signed in, unless the phone's secure storage doesn't answer at that first launch; then you sign in again.

Details: TC-3045
