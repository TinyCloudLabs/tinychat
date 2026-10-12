---
"@tinychat/frontend": patch
---

Choosing Local, or recording on Local, now starts the on-device model download by itself and never blocks recording. The note is saved normally and is transcribed on the phone once the model is ready, including after the app is relaunched mid-download. Progress shows quietly ("Downloading on-device model · 42%"), a failure says so with "Try again", and the Wi-Fi-only rule shows "Waiting for Wi-Fi" instead of a dead end. A Local choice is never silently switched to another transcriber.
