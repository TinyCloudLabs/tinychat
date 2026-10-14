---
"@tinychat/frontend": minor
"exo-desktop": minor
---

Handle a full TinyCloud storage across voice notes: pause audio uploads while full (audio stays on device, marked waiting for space), show "Manage storage" in place of "Save now" with a button that opens the storage management page in the external browser, and mark the Settings entry, the upload setting and the transcriber setting as paused while storage is full. Transcripts that storage refuses are held on the device (Private, on-device and hosted paths) and saved once storage accepts writes again. Held audio and transcripts resume automatically after a successful space write.
